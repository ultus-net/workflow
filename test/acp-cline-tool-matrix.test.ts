import assert from "node:assert/strict";
import test from "node:test";

import { AcpHostAdapter, taskId, type ProposedToolAction, type ToolCapability } from "../src/index.js";
import { createWorkflowAcpPermissionResolver } from "../src/adapters/acp-workflow-resolver.js";
import type { AcpPermissionRequestParams } from "../src/adapters/acp-permission.js";

// Full approval-gated tool surface of Cline 3.0.61, mirrored from
// apps/vscode/src/sdk/sdk-tool-policies.ts (gated sets) plus the legacy alias
// write_file observed in the mature Workflow ClineHostAdapter. ACP kinds follow
// apps/cli/src/acp/tool-utils.ts: unmapped tools arrive as "other".
const GATED_SURFACE: readonly {
  readonly tool: string;
  readonly kind: string;
  readonly capability: ToolCapability;
  readonly rawInput: unknown;
  readonly subjects: readonly string[];
}[] = [
  { tool: "read_files", kind: "read", capability: "read", rawInput: { files: [{ path: "/repo/a.ts" }] }, subjects: ["/repo/a.ts"] },
  { tool: "read_file", kind: "other", capability: "read", rawInput: { path: "/repo/a.ts" }, subjects: ["/repo/a.ts"] },
  { tool: "list_files", kind: "other", capability: "read", rawInput: { path: "/repo/src" }, subjects: ["/repo/src"] },
  { tool: "list_code_definition_names", kind: "other", capability: "read", rawInput: { path: "/repo/src" }, subjects: ["/repo/src"] },
  { tool: "search_files", kind: "other", capability: "read", rawInput: { path: "/repo/src", regex: "TODO" }, subjects: ["/repo/src"] },
  { tool: "search_codebase", kind: "search", capability: "read", rawInput: { queries: ["auth flow"] }, subjects: [] },
  { tool: "editor", kind: "edit", capability: "mutation", rawInput: { path: "/repo/a.ts", old_text: "a", new_text: "b" }, subjects: ["/repo/a.ts"] },
  { tool: "replace_in_file", kind: "other", capability: "mutation", rawInput: { path: "/repo/a.ts", diff: "@@" }, subjects: ["/repo/a.ts"] },
  { tool: "write_to_file", kind: "other", capability: "mutation", rawInput: { path: "/repo/a.ts", content: "x" }, subjects: ["/repo/a.ts"] },
  { tool: "write_file", kind: "other", capability: "mutation", rawInput: { path: "/repo/a.ts", content: "x" }, subjects: ["/repo/a.ts"] },
  { tool: "apply_patch", kind: "other", capability: "mutation", rawInput: { path: "/repo/a.ts", patch: "***" }, subjects: ["/repo/a.ts"] },
  { tool: "delete_file", kind: "other", capability: "mutation", rawInput: { path: "/repo/a.ts" }, subjects: ["/repo/a.ts"] },
  { tool: "run_commands", kind: "execute", capability: "process", rawInput: { commands: ["npm test"] }, subjects: [] },
  { tool: "execute_command", kind: "other", capability: "process", rawInput: { command: "npm test" }, subjects: [] },
  { tool: "fetch_web_content", kind: "fetch", capability: "network", rawInput: { requests: [{ url: "https://example.com" }] }, subjects: [] },
  { tool: "web_fetch", kind: "other", capability: "network", rawInput: { url: "https://example.com" }, subjects: [] },
  { tool: "web_search", kind: "search", capability: "network", rawInput: { query: "acp spec" }, subjects: [] },
];

const options = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

function resolver(tool: string, capability: ToolCapability, seen: ProposedToolAction[]) {
  return createWorkflowAcpPermissionResolver({
    adapter: new AcpHostAdapter({ authoritativePermissions: true }),
    correlation: {
      sessionId: "workflow-session",
      agentSessionId: "cline-session",
      taskId: taskId("TASK"),
      toolName: tool,
      capability,
    },
    authorize(action) {
      seen.push(action);
      return { kind: "allow" };
    },
  });
}

function request(tool: string, kind: string, rawInput: unknown): AcpPermissionRequestParams {
  return {
    sessionId: "cline-session",
    toolCall: { toolCallId: `tool-${tool}`, title: tool, kind, rawInput },
    options,
  };
}

test("matrix covers the complete Cline 3.0.61 approval-gated tool surface", () => {
  assert.deepEqual(
    GATED_SURFACE.map((entry) => entry.tool).sort(),
    [
      "apply_patch", "delete_file", "editor", "execute_command", "fetch_web_content",
      "list_code_definition_names", "list_files", "read_file", "read_files",
      "replace_in_file", "run_commands", "search_codebase", "search_files",
      "web_fetch", "web_search", "write_file", "write_to_file",
    ].sort(),
  );
});

test("every gated Cline tool is recognized and maps expected subjects", async () => {
  for (const entry of GATED_SURFACE) {
    const seen: ProposedToolAction[] = [];
    const resolve = resolver(entry.tool, entry.capability, seen);
    assert.deepEqual(await resolve(request(entry.tool, entry.kind, entry.rawInput)), { kind: "allow" }, entry.tool);
    assert.equal(seen.length, 1, entry.tool);
    assert.deepEqual(seen[0]?.subjects, entry.subjects, entry.tool);
    assert.deepEqual(seen[0]?.input, entry.rawInput, entry.tool);
  }
});

test("read_files accepts file_paths and paths string arrays with strict validation", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver("read_files", "read", seen);
  await resolve(request("read_files", "read", { file_paths: ["/repo/a.ts", "/repo/b.ts"] }));
  await resolve(request("read_files", "read", { paths: ["/repo/c.ts"] }));
  assert.deepEqual(seen[0]?.subjects, ["/repo/a.ts", "/repo/b.ts"]);
  assert.deepEqual(seen[1]?.subjects, ["/repo/c.ts"]);
  await assert.rejects(
    () => resolve(request("read_files", "read", { file_paths: ["/repo/a.ts", " "] })),
    /invalid ACP read_files path/,
  );
  assert.equal(seen.length, 2);
});

test("search_codebase preserves its optional path as an authorization subject", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver("search_codebase", "read", seen);
  await resolve(request("search_codebase", "search", { queries: ["auth flow"], path: "/repo/src" }));
  await resolve(request("search_codebase", "search", { queries: ["auth flow"] }));
  assert.deepEqual(seen[0]?.subjects, ["/repo/src"]);
  assert.deepEqual(seen[1]?.subjects, []);
});

test("every path-subject tool fails closed without a usable path", async () => {
  const pathTools = [
    "read_file", "list_files", "list_code_definition_names", "search_files",
    "editor", "replace_in_file", "write_to_file", "write_file", "apply_patch", "delete_file",
  ];
  for (const tool of pathTools) {
    const seen: ProposedToolAction[] = [];
    const capability: ToolCapability = tool.startsWith("read") || tool.startsWith("list") || tool.startsWith("search") ? "read" : "mutation";
    const resolve = resolver(tool, capability, seen);
    await assert.rejects(() => resolve(request(tool, "other", {})), /no authorization subject/, tool);
    assert.equal(seen.length, 0, tool);
  }
});

test("run_commands validates string, object-entry, and bare-string command forms", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver("run_commands", "process", seen);
  await resolve(request("run_commands", "execute", { commands: ["npm test"] }));
  await resolve(request("run_commands", "execute", { commands: [{ command: "git", args: ["status"] }] }));
  await resolve(request("run_commands", "execute", { commands: ["npm test"], cwd: "/repo" }));
  await resolve(request("run_commands", "execute", "npm test"));
  assert.deepEqual(seen[0]?.subjects, []);
  assert.deepEqual(seen[1]?.subjects, []);
  assert.deepEqual(seen[2]?.subjects, ["/repo"]);
  assert.deepEqual(seen[3]?.subjects, []);
  assert.deepEqual(seen[3]?.input, "npm test");
});

test("run_commands fails closed on missing, empty, or malformed commands", async () => {
  const malformed: readonly unknown[] = [
    {},
    { commands: [] },
    { commands: ["npm test", 42] },
    { commands: [{ command: " " }] },
    { commands: ["ok", {}] },
    "   ",
  ];
  for (const rawInput of malformed) {
    const seen: ProposedToolAction[] = [];
    const resolve = resolver("run_commands", "process", seen);
    await assert.rejects(
      () => resolve(request("run_commands", "execute", rawInput)),
      /no command|invalid ACP run_commands command entry/,
    );
    assert.equal(seen.length, 0);
  }
});

test("process tools never place command text into subjects", async () => {
  const seen: ProposedToolAction[] = [];
  const resolve = resolver("run_commands", "process", seen);
  await resolve(request("run_commands", "execute", { commands: ["echo -n 'shell' >> shell-target.txt"], cwd: "/repo" }));
  // Subjects are workspace paths only; the kernel checks each one with
  // pathWithinWorkspace, so command text would be misclassified as a pseudo-path
  // rather than authorized under process policy.
  assert.deepEqual(seen[0]?.subjects, ["/repo"]);
});

test("shell and bash behave as process-tool aliases (command required, cwd-only subject)", async () => {
  // Cline gates run_commands, but a host may name its shell tool differently;
  // the aliases keep such requests recognized as process tools (rather than
  // failing closed as unknown mutation tools) under identical validation.
  for (const tool of ["shell", "bash"]) {
    const seen: ProposedToolAction[] = [];
    const resolve = resolver(tool, "process", seen);
    await resolve(request(tool, "execute", { command: "npm test", cwd: "/repo" }));
    assert.deepEqual(seen[0]?.subjects, ["/repo"], tool);
    await assert.rejects(() => resolve(request(tool, "execute", {})), /no command/, tool);
    await assert.rejects(() => resolve(request(tool, "execute", " ")), /no command/, tool);
    assert.equal(seen.length, 1, tool);
  }
});
