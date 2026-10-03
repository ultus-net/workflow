import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface Recorded {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

let hub: Server;
let hubUrl: string;
let requests: Recorded[];

function respond(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

before(async () => {
  requests = [];
  hub = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
      requests.push({ url: request.url ?? "", authorization: request.headers.authorization, body });
      if (request.url === "/steps/list") return respond(response, 200, { steps: [] });
      if (request.url === "/steps/define") return respond(response, 200, { steps: [{ id: "s1", taskId: "t1", content: "write", state: "PENDING", requiredEvidence: [] }] });
      if (request.url === "/steps/complete") {
        return respond(response, 409, { kind: "rejected", code: "STEP_POSTCONDITION_UNMET", reason: "claimed change did not re-appear" });
      }
      return respond(response, 200, { kind: "accepted", step: { id: "s1", taskId: "t1", content: "write", state: "IN_PROGRESS", requiredEvidence: [] } });
    });
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const address = hub.address();
  assert.ok(address !== null && typeof address === "object");
  hubUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => hub.close(() => resolve()));
});

function connect(): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.WORKFLOW_HUB_URL = hubUrl;
  env.WORKFLOW_HUB_TOKEN = "test-token";
  const client = new Client({ name: "workflow-task-mcp-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/server.js"], cwd: process.cwd(), stderr: "pipe", env });
  return client.connect(transport).then(() => client);
}

test("advertises the five canonical step-ledger tools with a declared result shape", async () => {
  const client = await connect();
  try {
    assert.deepEqual(client.getServerVersion(), { name: "workflow-task-mcp", version: "0.1.0" });
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["step_list", "step_define", "step_start", "step_complete", "step_cancel"]);
    for (const tool of tools) assert.ok(tool.outputSchema, `${tool.name} must declare an outputSchema`);
    assert.equal(tools.find((tool) => tool.name === "step_list")?.annotations?.readOnlyHint, true);
    assert.match(tools.find((tool) => tool.name === "step_complete")?.description ?? "", /re-queries the real file fingerprint/);
  } finally {
    await client.close();
  }
});

test("drives the hub with the Bearer token and returns the ledger", async () => {
  const client = await connect();
  try {
    requests.length = 0;
    const listed = await client.callTool({ name: "step_list", arguments: { taskId: "t1", workspace: "/w" } });
    assert.equal(listed.isError, undefined, JSON.stringify(listed.content));
    assert.deepEqual(listed.structuredContent, { steps: [] });
    assert.equal(requests.at(-1)?.url, "/steps/list");
    assert.equal(requests.at(-1)?.authorization, "Bearer test-token");
    assert.deepEqual(requests.at(-1)?.body, { taskId: "t1", workspace: "/w" });

    const defined = await client.callTool({ name: "step_define", arguments: { taskId: "t1", steps: [{ content: "write", requiredEvidence: [] }] } });
    assert.equal(defined.isError, undefined, JSON.stringify(defined.content));
    assert.equal(requests.at(-1)?.url, "/steps/define");
  } finally {
    await client.close();
  }
});

test("a kernel rejection is surfaced as a tool error, never a silent success", async () => {
  const client = await connect();
  try {
    requests.length = 0;
    const completed = await client.callTool({ name: "step_complete", arguments: { id: "s1" } });
    assert.equal(completed.isError, true, "a 409 refusal must set isError");
    assert.equal(requests.at(-1)?.url, "/steps/complete");
    const text = completed.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    assert.match(text, /STEP_POSTCONDITION_UNMET/);
  } finally {
    await client.close();
  }
});

test("an accepted transition round-trips through the declared output schema", async () => {
  const client = await connect();
  try {
    requests.length = 0;
    const started = await client.callTool({ name: "step_start", arguments: { id: "s1" } });
    assert.equal(started.isError, undefined, JSON.stringify(started.content));
    const structured = started.structuredContent as { transition: { kind: string } };
    assert.equal(structured.transition.kind, "accepted");
    assert.equal(requests.at(-1)?.url, "/steps/start");
  } finally {
    await client.close();
  }
});
