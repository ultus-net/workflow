import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProxiedBubblewrapContainment } from "../src/containment/proxied-bwrap.js";
import type { EgressPolicy } from "../src/integrations/egress-policy.js";

/**
 * W183 gated probe: a real contained process on the `network: "proxied"`
 * posture speaking HTTP through the parent-side forward proxy. It proves the
 * two claims the mechanism rests on:
 *
 *   1. the sandbox's proxy-aware HTTP egress actually traverses the policy
 *      proxy (an allowed host returns the upstream body), and
 *   2. an unlisted host is denied on the proxy path (403), not carried
 *      through by slirp.
 *
 * It requires a user-mode network stack (slirp4netns) and unprivileged user
 * namespaces, so it is **gated** and skips without `WORKFLOW_ACP_CONTAINED_EGRESS=1`.
 * The live arm has not been run as of 2026-10-02; a green run here is evidence
 * for the W183 narrowing (proxy-aware traffic is mediated), never for a
 * raw-socket fence, which stays a stated THREAT_MODEL residual.
 */
const runProbe = process.env.WORKFLOW_ACP_CONTAINED_EGRESS === "1";

/** The in-sandbox program: honor HTTP_PROXY and issue origin-form requests. */
const PROBE_SCRIPT = `
const http = require("node:http");
const [allowedHost, allowedPort, deniedHost, deniedPort] = process.argv.slice(2);
const proxy = new URL(process.env.HTTP_PROXY);
function call(host, port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: proxy.hostname, port: Number(proxy.port), path: "/probe", method: "GET", headers: { host: host + ":" + port }, timeout: 5000 },
      (res) => { let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, body })); },
    );
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, error: String(e) }));
    req.end();
  });
}
(async () => {
  const allowed = await call(allowedHost, allowedPort);
  const denied = await call(deniedHost, deniedPort);
  process.stdout.write(JSON.stringify({ allowed, denied }));
})();
`;

test(
  "W183 contained agent HTTP egress traverses the policy proxy and an unlisted host is denied on the proxy path",
  { skip: !runProbe, timeout: 120_000 },
  async () => {
    const upstream = createServer((_req, res) => { res.writeHead(200); res.end("PROXIED-UPSTREAM"); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("probe upstream failed to bind");
    const allowedHost = "127.0.0.1";
    const allowedPort = address.port;
    // No rule covers this port, so the proxy must refuse it (deny-by-default).
    const deniedPort = allowedPort === 9 ? 10 : 9;

    const scratch = await mkdtemp(path.join(tmpdir(), "wf-egress-probe-"));
    const script = path.join(scratch, "probe.cjs");
    await writeFile(script, PROBE_SCRIPT);

    const policy: EgressPolicy = { rules: [{ id: "allow-upstream", host: allowedHost, port: allowedPort, mode: "enforce" }] };
    const containment = new ProxiedBubblewrapContainment();
    try {
      const result = await containment.execute({
        executable: process.execPath,
        args: [script, allowedHost, String(allowedPort), allowedHost, String(deniedPort)],
        network: "proxied",
        proxiedEgressPolicy: policy,
        readablePaths: [scratch],
      });

      assert.equal(result.network, "proxied");
      assert.equal(result.enforcement, "enforced");
      assert.equal(result.exitCode, 0, `contained probe exited non-zero: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout.trim()) as {
        allowed: { status: number; body?: string };
        denied: { status: number };
      };
      // Proxy-aware egress is mediated: the allowed host reaches upstream...
      assert.equal(parsed.allowed.status, 200);
      assert.equal(parsed.allowed.body, "PROXIED-UPSTREAM");
      // ...and the unlisted host is denied at the proxy, not carried through.
      assert.equal(parsed.denied.status, 403);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
