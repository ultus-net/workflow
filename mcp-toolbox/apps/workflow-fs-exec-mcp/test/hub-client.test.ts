import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { authorizeBeforeTool, resolveHub, runBash } from "../src/hub-client.js";
import { applyEdit, applyWrite, resolveWithinWorkspace } from "../src/fs-ops.js";

/**
 * Plan Task G3: the substitution tools authorize through the hub before
 * acting, and every hub failure mode is a denial. A stub hub exercises the
 * wire contract; fs bounds are tested separately with real symlink escapes.
 */

let stub: Server;
let hubUrl = "";
let calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let mode: "allow" | "deny" | "unreachable" = "allow";

before(async () => {
  stub = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      const body = raw.length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>;
      calls.push({ path: request.url ?? "", body });
      const authorization = request.headers.authorization ?? "";
      if (authorization !== "Bearer stub-token") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "bad token" }));
        return;
      }
      if (request.url === "/before-tool") {
        if (mode === "deny") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ stop: true, reason: "blocked by policy" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.url === "/bash") {
        if (mode === "deny") {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "command blocked" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ output: "stubbed output" }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  hubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  process.env.WORKFLOW_HUB_ENDPOINT = hubUrl;
  process.env.WORKFLOW_HUB_TOKEN = "stub-token";
});

after(async () => {
  delete process.env.WORKFLOW_HUB_ENDPOINT;
  delete process.env.WORKFLOW_HUB_TOKEN;
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

test("resolveHub prefers explicit env credentials", () => {
  assert.deepEqual(resolveHub(), { endpoint: hubUrl, token: "stub-token" });
});

test("authorizeBeforeTool passes the authorization shape and fails closed on stop", async () => {
  calls = [];
  mode = "allow";
  await authorizeBeforeTool({ toolCall: { toolName: "write_to_file" }, input: { path: "a.ts", content: "x" }, workspace: "/ws" });
  assert.deepEqual(calls[0]!.path, "/before-tool");
  assert.deepEqual(calls[0]!.body, {
    toolCall: { toolName: "write_to_file" },
    input: { path: "a.ts", content: "x" },
    workspace: "/ws",
  });

  mode = "deny";
  await assert.rejects(
    authorizeBeforeTool({ toolCall: { toolName: "write_to_file" }, input: { path: "a.ts", content: "x" }, workspace: "/ws" }),
    /blocked by policy/,
  );
  mode = "allow";
});

test("runBash routes through the hub's contained execution and surfaces failures", async () => {
  calls = [];
  const output = await runBash({ command: "echo hi", cwd: "/ws" });
  assert.equal(output, "stubbed output");
  assert.deepEqual(calls[0]!.body, { command: "echo hi", cwd: "/ws" });

  mode = "deny";
  await assert.rejects(runBash({ command: "blocked", cwd: "/ws" }), /command blocked/);
  mode = "allow";
});

test("an unreachable hub is a denial, never an allow", async () => {
  const saved = process.env.WORKFLOW_HUB_ENDPOINT;
  process.env.WORKFLOW_HUB_ENDPOINT = "http://127.0.0.1:1";
  try {
    await assert.rejects(
      authorizeBeforeTool({ toolCall: { toolName: "write_to_file" }, input: { path: "a.ts" }, workspace: "/ws" }),
      /unreachable|hub/i,
    );
  } finally {
    process.env.WORKFLOW_HUB_ENDPOINT = saved;
  }
});

test("a bad token fails closed with the stale-discovery semantics", async () => {
  const saved = process.env.WORKFLOW_HUB_TOKEN;
  process.env.WORKFLOW_HUB_TOKEN = "wrong";
  try {
    await assert.rejects(
      authorizeBeforeTool({ toolCall: { toolName: "write_to_file" }, input: { path: "a.ts" }, workspace: "/ws" }),
      /rejected the credential/,
    );
  } finally {
    process.env.WORKFLOW_HUB_TOKEN = saved;
  }
});

// ── fs bounds: real symlink escapes ────────────────────────────────────────

test("fs writes stay inside the workspace and reject symlinked escapes", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "wf-fs-exec-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "wf-fs-exec-out-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  // Clean write inside the workspace (nested parent creation).
  applyWrite({ workspace, path: "src/deep/new.ts", content: "export {};\n" });
  assert.equal(resolveWithinWorkspace(workspace, "src/deep/new.ts").endsWith("new.ts"), true);

  // Lexical traversal is rejected.
  assert.throws(() => resolveWithinWorkspace(workspace, "../../etc/passwd"), /outside the workspace/);
  assert.throws(() => resolveWithinWorkspace(workspace, outside), /outside the workspace/);
  assert.throws(() => resolveWithinWorkspace(workspace, ""), /empty/);

  // Symlinked directory escape (the known bypass shape from the corpus).
  mkdirSync(join(workspace, "link-parent"), { recursive: true });
  symlinkSync(outside, join(workspace, "link-parent", "escape"));
  assert.throws(
    () => applyWrite({ workspace, path: "link-parent/escape/pwned.ts", content: "x" }),
    /symlinked escape/,
  );

  // DANGLING final symlink escape (P0 regression, empirically confirmed by
  // review before the fix): existsSync treats it as nonexistent, and
  // writeFileSync would follow it outside the workspace. It must be denied.
  const danglingTarget = join(outside, "pwned-through-dangling.ts");
  symlinkSync(danglingTarget, join(workspace, "dangling-link"));
  assert.throws(
    () => applyWrite({ workspace, path: "dangling-link", content: "exfil" }),
    /dangling symlink/,
  );
  assert.equal(
    lstatSync(danglingTarget, { throwIfNoEntry: false }),
    undefined,
    "the dangling symlink must not have been followed to create the outside file",
  );

  // A symlink whose target is INSIDE the workspace is deliverable (the
  // resolution stays within bounds).
  writeFileSync(join(workspace, "real-target.ts"), "x", "utf8");
  symlinkSync(join(workspace, "real-target.ts"), join(workspace, "inner-link.ts"));
  assert.doesNotThrow(() => resolveWithinWorkspace(workspace, "inner-link.ts"));

  // Exact-string edit semantics.
  writeFileSync(join(workspace, "edit.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
  assert.deepEqual(
    applyEdit({ workspace, path: "edit.ts", oldString: "const a = 1;", newString: "const a = 10;" }),
    { target: resolveWithinWorkspace(workspace, "edit.ts"), replacements: 1 },
  );
  assert.throws(
    () => applyEdit({ workspace, path: "edit.ts", oldString: "const", newString: "x" }),
    /ambiguous/,
  );
  assert.throws(
    () => applyEdit({ workspace, path: "edit.ts", oldString: "missing", newString: "x" }),
    /not found/,
  );
});
