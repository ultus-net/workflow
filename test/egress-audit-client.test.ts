import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  EGRESS_LEDGER_TOKEN_CLASSES,
  createEgressAuditAppender,
  createEgressAuditFeed,
  egressReachInput,
  egressRejectInput,
  type EgressReachInput,
  type EgressRejectInput,
} from "../src/integrations/egress-audit-client.js";
import { EGRESS_TOKEN_CLASSES } from "../src/integrations/egress-ledger.js";
import type { EgressObservation } from "../src/integrations/model-usage-proxy.js";

const reach: EgressObservation = {
  kind: "reach",
  destination: "api.example.com",
  functionClass: "chat-completions",
  tokenClass: "session-placeholder",
  anomalyContext: { credentialHeader: undefined },
};

const reject: EgressObservation = {
  kind: "reject",
  destination: "api.example.com",
  functionClass: "chat-completions",
  tokenClass: "foreign",
  anomalyContext: { policy: "egress-credential", credentialHeader: "authorization" },
};

test("W181 A5: the mapper forwards reaches and rejects to their distinct ledger inputs", () => {
  assert.deepEqual(egressReachInput(reach), {
    domain: "api.example.com",
    functionClass: "chat-completions",
    tokenClass: "session-placeholder",
    source: "model-usage-proxy",
  });
  assert.equal(egressRejectInput(reach), undefined);
  assert.deepEqual(egressRejectInput(reject), {
    domain: "api.example.com",
    functionClass: "chat-completions",
    tokenClass: "foreign",
    policy: "egress-credential",
    source: "model-usage-proxy",
  });
  assert.equal(egressReachInput(reject), undefined);
});

test("W181 A5: the bridge re-exports the ledger's token-class set (single declaration, cannot drift)", () => {
  // The ledger is now in-process, so the bridge no longer mirrors a second
  // declaration: it re-exports the ledger's own list. This pin fails if the
  // ledger's closed set changes without the bridge following.
  assert.equal(EGRESS_LEDGER_TOKEN_CLASSES, EGRESS_TOKEN_CLASSES);
  assert.deepEqual([...EGRESS_LEDGER_TOKEN_CLASSES].sort(), ["absent", "foreign", "session-placeholder", "unknown"]);
});

test("W181 A5: the feed serializes appends, preserves order, and routes reach and reject distinctly", async () => {
  const appended: (EgressReachInput | EgressRejectInput)[] = [];
  let active = 0;
  let maxActive = 0;
  const appender = {
    async appendReach(input: EgressReachInput): Promise<void> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      appended.push(input);
      active -= 1;
    },
    async appendReject(input: EgressRejectInput): Promise<void> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      appended.push(input);
      active -= 1;
    },
    async close(): Promise<void> {},
  };
  const feed = createEgressAuditFeed({ appender });
  feed(reject);
  feed(reach);
  feed({ ...reach, functionClass: "models-list" });
  // Let the serialized queue drain.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  assert.equal(maxActive, 1, "appends are serialized (one in flight at a time)");
  assert.deepEqual(appended.map((input) => input.functionClass), ["chat-completions", "chat-completions", "models-list"]);
  assert.equal("policy" in appended[0]!, true, "the reject lands on appendReject with its policy tag");
  assert.equal("policy" in appended[1]!, false, "the reach lands on appendReach");
});

test("W181 A5: the feed is bounded — a wedged ledger drops events instead of growing memory", async () => {
  let release: (() => void) | undefined;
  const appender = {
    appendReach: (): Promise<void> => new Promise<void>((resolveAppend) => { release = resolveAppend; }),
    async appendReject(): Promise<void> {},
    async close(): Promise<void> {},
  };
  const errors: unknown[] = [];
  const feed = createEgressAuditFeed({ appender, maxPending: 2, onError: (error) => errors.push(error) });
  feed(reach); // in flight, never resolves → pending 1
  feed(reach); // queued → pending 2
  feed(reach); // saturated → dropped
  feed(reach); // saturated → dropped
  assert.equal(errors.length, 2, "each event past the bound is reported, not queued");
  assert.match(String(errors[0]), /saturated/);
  release?.();
});

test("W181 A5: an appender failure is swallowed by default (the audit sink is advisory)", async () => {
  const errors: unknown[] = [];
  const appender = {
    async appendReach(): Promise<void> {
      throw new Error("ledger refused the append");
    },
    async appendReject(): Promise<void> {},
    async close(): Promise<void> {},
  };
  const feed = createEgressAuditFeed({ appender, onError: (error) => errors.push(error) });
  assert.doesNotThrow(() => feed(reach));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /ledger refused/);
});

test("W181 A5: the appender writes reaches and rejects into the in-process ledger document", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "egress-bridge-"));
  const appender = await createEgressAuditAppender({ dataDir });
  try {
    await appender.appendReach({
      domain: "api.example.com",
      functionClass: "chat-completions",
      tokenClass: "session-placeholder",
      source: "model-usage-proxy",
    });
    await appender.appendReach({
      domain: "api.example.com",
      functionClass: "file-upload",
      tokenClass: "foreign",
      source: "model-usage-proxy",
    });
    await appender.appendReject({
      domain: "api.example.com",
      functionClass: "file-upload",
      tokenClass: "foreign",
      policy: "egress-credential",
      source: "model-usage-proxy",
    });
  } finally {
    await appender.close();
  }
  try {
    const ledger = JSON.parse(readFileSync(join(dataDir, "egress-audit-ledger.json"), "utf8")) as {
      entries: Array<{ domain: string; functionClass: string; tokenClass: string; source: string; anomalies: string[] }>;
      rejects: Array<{ domain: string; policy: string; tokenClass: string }>;
    };
    assert.equal(ledger.entries.length, 2);
    assert.equal(ledger.entries[0]?.tokenClass, "session-placeholder");
    assert.deepEqual(ledger.entries[0]?.anomalies, ["new-domain"]);
    assert.deepEqual(ledger.entries[1]?.anomalies.sort(), ["new-function-class-on-known-domain", "non-session-token-observed"]);
    assert.equal(ledger.rejects.length, 1, "the reject lands in the separate rejects array");
    assert.equal(ledger.rejects[0]?.policy, "egress-credential");
    assert.ok(!JSON.stringify(ledger).includes("workflow-metered"), "the placeholder value never enters the ledger");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("W181 A5: the runtime feed is inert without its env gate and in-process when set", async () => {
  const { createEgressRuntimeFeed } = await import("../src/integrations/egress-audit-client.js");
  assert.equal(await createEgressRuntimeFeed({ env: {} }), undefined, "off by default");
  const dataDir = mkdtempSync(join(tmpdir(), "egress-feed-"));
  const feed = await createEgressRuntimeFeed({ env: { WORKFLOW_EGRESS_AUDIT_FEED: "1" }, dataDir });
  assert.ok(feed, "gated on, the in-process feed is available");
  feed!.onEgressObservation(reach);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  await feed!.close();
  const ledger = JSON.parse(readFileSync(join(dataDir, "egress-audit-ledger.json"), "utf8")) as { entries: unknown[] };
  assert.equal(ledger.entries.length, 1);
  rmSync(dataDir, { recursive: true, force: true });
});
