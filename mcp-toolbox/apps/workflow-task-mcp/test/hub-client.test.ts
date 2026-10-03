import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  callStepRoute,
  hubDiscoveryDirectory,
  HubStepError,
  readHubCredentials,
  resolveHubCredentials,
  STEP_ROUTES,
} from "../src/hub-client.js";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

function startHub(handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void): Promise<{ server: Server; url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
      requests.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, body });
      handler(request, response, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      resolve({ server, url: `http://127.0.0.1:${address.port}`, requests });
    });
  });
}

test("callStepRoute POSTs the JSON body and Bearer token to /steps/<route>", async () => {
  const { server, url, requests } = await startHub((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ steps: [] }));
  });
  try {
    const { body } = await callStepRoute("list", { taskId: "t1", workspace: "/w" }, { credentials: { url, token: "secret-token" } });
    assert.deepEqual(body, { steps: [] });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.url, "/steps/list");
    assert.equal(requests[0]?.authorization, "Bearer secret-token");
    assert.deepEqual(requests[0]?.body, { taskId: "t1", workspace: "/w" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("callStepRoute surfaces a hub 409 kernel rejection verbatim as a HubStepError", async () => {
  const rejection = { kind: "rejected", code: "STEP_POSTCONDITION_UNMET", reason: "claimed change did not re-appear" };
  const { server, url } = await startHub((_request, response) => {
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify(rejection));
  });
  try {
    await assert.rejects(
      () => callStepRoute("complete", { id: "s1" }, { credentials: { url, token: "t" } }),
      (error: unknown) => {
        assert.ok(error instanceof HubStepError);
        assert.equal(error.status, 409);
        assert.deepEqual(error.detail, rejection);
        assert.match(error.message, /STEP_POSTCONDITION_UNMET: claimed change did not re-appear/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("callStepRoute surfaces a hub 400 boundary fault as a HubStepError", async () => {
  const { server, url } = await startHub((_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid step define request: steps must be an array" }));
  });
  try {
    await assert.rejects(
      () => callStepRoute("define", { taskId: "t1", steps: "nope" }, { credentials: { url, token: "t" } }),
      (error: unknown) => {
        assert.ok(error instanceof HubStepError);
        assert.equal(error.status, 400);
        assert.equal(error.message, "invalid step define request: steps must be an array");
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("callStepRoute fails closed when the hub is not configured or unreachable", async () => {
  const previousUrl = process.env.WORKFLOW_HUB_URL;
  const previousToken = process.env.WORKFLOW_HUB_TOKEN;
  const previousDir = process.env.WORKFLOW_HUB_DIR;
  delete process.env.WORKFLOW_HUB_URL;
  delete process.env.WORKFLOW_HUB_TOKEN;
  const emptyDir = mkdtempSync(join(tmpdir(), "wf-task-mcp-empty-"));
  // Point discovery at an empty directory so a real hub on this machine cannot
  // be found (the "not configured" precondition).
  process.env.WORKFLOW_HUB_DIR = emptyDir;
  try {
    // No discovery file anywhere and no env override: refuse rather than no-op.
    assert.equal(resolveHubCredentials(emptyDir), undefined);
    await assert.rejects(
      () => callStepRoute("list", { taskId: "t1" }, { credentials: undefined }),
      /not configured/,
    );
    // Configured but unreachable: a clear error, still no fabricated success.
    await assert.rejects(
      () => callStepRoute("list", { taskId: "t1" }, { credentials: { url: "http://127.0.0.1:1", token: "t" } }),
      /unreachable/,
    );
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
    if (previousUrl !== undefined) process.env.WORKFLOW_HUB_URL = previousUrl;
    if (previousToken !== undefined) process.env.WORKFLOW_HUB_TOKEN = previousToken;
    if (previousDir === undefined) delete process.env.WORKFLOW_HUB_DIR;
    else process.env.WORKFLOW_HUB_DIR = previousDir;
  }
});

test("readHubCredentials mirrors the discovery file shape and is fail-closed on malformed input", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-task-mcp-discovery-"));
  try {
    mkdirSync(join(dir, "hub"), { recursive: true });
    assert.equal(hubDiscoveryDirectory(dir), dir);
    assert.equal(readHubCredentials(dir), undefined, "no file -> undefined");

    writeFileSync(join(dir, "hub", "discovery.json"), JSON.stringify({ endpoint: "http://127.0.0.1:9", token: "tok" }));
    assert.deepEqual(readHubCredentials(dir), { url: "http://127.0.0.1:9", token: "tok" });

    writeFileSync(join(dir, "hub", "discovery.json"), JSON.stringify({ endpoint: "http://127.0.0.1:9" }));
    assert.equal(readHubCredentials(dir), undefined, "missing token -> undefined");

    writeFileSync(join(dir, "hub", "discovery.json"), "not json");
    assert.equal(readHubCredentials(dir), undefined, "unparseable -> undefined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("STEP_ROUTES is the closed set the server drives", () => {
  assert.deepEqual([...STEP_ROUTES], ["list", "define", "start", "complete", "cancel"]);
});
