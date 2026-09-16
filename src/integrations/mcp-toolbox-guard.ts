import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { normalizeMcpEvidence, type McpCapability, type McpProvider } from "../adapters/mcp.js";
import type { Evidence } from "../kernel/contracts.js";
import { materializeMcpEnvironment, type McpCredentialBinding } from "./credential-mcp.js";
import type { CredentialBroker } from "./credentials.js";

/**
 * First-class integration with the vendored workflow-guard-mcp server
 * (`mcp-toolbox/apps/workflow-guard-mcp`). MCP remains capability and
 * observation plumbing; Workflow's kernel owns task state.
 */

export interface GuardCheckInput {
  action: "shell" | "file_write" | "git" | "network" | "mcp";
  command?: string;
  path?: string;
  workspaceRoot?: string;
  content?: string;
  patchText?: string;
  currentBranch?: string;
  protectedBranches?: string[];
  trustedRole?: string;
  toolName?: string;
  failureCount?: number;
}

export interface GuardDecision {
  decision: "allow" | "deny" | "ask";
  policy: string;
  reason: string;
}

export interface GuardStatus {
  mode: string;
  enforcement: string;
  executesActions: boolean;
}

export interface WorkflowGuardProvider extends McpProvider {
  guardCheck(input: GuardCheckInput): Promise<GuardDecision>;
  guardStatus(): Promise<GuardStatus>;
  close(): Promise<void>;
}

export async function createWorkflowGuardMcpProvider(options: {
  serverPath: string;
  credentialBroker?: CredentialBroker;
  credentialBindings?: readonly McpCredentialBinding[];
  workspace?: string;
}): Promise<WorkflowGuardProvider> {
  const env = options.credentialBindings === undefined || options.credentialBindings.length === 0
    ? undefined
    : await materializeMcpEnvironment(requiredBroker(options.credentialBroker), {
      consumer: "mcp:workflow-guard",
      workspace: options.workspace ?? process.cwd(),
      bindings: options.credentialBindings,
    });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverPath],
    ...(env === undefined ? {} : { env }),
    stderr: "pipe",
  });
  const client = new Client({ name: "workflow", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  if (!names.includes("guard_check")) {
    await client.close();
    throw new Error("workflow-guard-mcp did not expose guard_check");
  }

  return {
    async capabilities(): Promise<readonly McpCapability[]> {
      return names.map((name) => ({ name }));
    },
    async invoke(capability: string, input: unknown): Promise<unknown> {
      const result = await client.callTool({ name: capability, arguments: input as Record<string, unknown> | undefined });
      return result.structuredContent ?? result.content;
    },
    async guardCheck(input: GuardCheckInput): Promise<GuardDecision> {
      const result = await client.callTool({ name: "guard_check", arguments: input as unknown as Record<string, unknown> });
      const structured = result.structuredContent;
      if (typeof structured === "object" && structured !== null) {
        const value = structured as Record<string, unknown>;
        if (typeof value.decision === "string" && typeof value.policy === "string" && typeof value.reason === "string") {
          return value as unknown as GuardDecision;
        }
      }
      throw new Error("guard_check returned no structured decision");
    },
    async guardStatus(): Promise<GuardStatus> {
      const result = await client.callTool({ name: "guard_status", arguments: {} });
      const text = result.content;
      if (Array.isArray(text) && text.length > 0) {
        const first = text[0] as { type: string; text?: string };
        if (typeof first.text === "string") {
          const parsed = JSON.parse(first.text) as GuardStatus;
          return parsed;
        }
      }
      throw new Error("guard_status returned no status payload");
    },
    close: () => client.close(),
  };
}

function requiredBroker(broker: CredentialBroker | undefined): CredentialBroker {
  if (broker === undefined) throw new Error("credential broker required for MCP credential bindings");
  return broker;
}

/** Resolves the vendored workflow-guard-mcp server entrypoint, building first if needed. */
export function defaultToolboxGuardServerPath(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const serverPath = resolve(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "dist", "server.js");
  if (!existsSync(serverPath)) {
    throw new Error(`workflow-guard-mcp is not built; run: npm run toolbox:build (expected ${serverPath})`);
  }
  return serverPath;
}

export function createDefaultToolboxGuardProvider(options: {
  credentialBroker?: CredentialBroker;
  credentialBindings?: readonly McpCredentialBinding[];
  workspace?: string;
} = {}): Promise<WorkflowGuardProvider> {
  return createWorkflowGuardMcpProvider({ serverPath: defaultToolboxGuardServerPath(), ...options });
}

export function guardPolicyEvidence(decision: GuardDecision, mutationEpoch: number): Evidence {
  return normalizeMcpEvidence(
    {
      observationId: `guard:${decision.policy}`,
      subject: `policy:${decision.policy}`,
      result: decision.decision === "allow" ? "passed" : "failed",
      observedAt: new Date().toISOString(),
    },
    mutationEpoch,
  );
}

// Plan Task G2: one shared tool-call → guard-input mapping, used by the
// Cline plugin (/before-tool route), the ACP permission resolver, and the
// OpenCode plugin, so every surface gets identical policy decisions from the
// guard dispatcher. Tool-name families cover the Cline hook surface, the ACP
// approval surface (run_commands, replace_in_file, delete_file, ...), and the
// OpenCode tool surface (edit, write, patch, bash, webfetch).
const SHELL_TOOLS = new Set(["execute_command", "bash", "run_commands", "shell"]);
const FILE_WRITE_TOOLS = new Set([
  "write_to_file",
  "new_file_template",
  "write_file",
  "editor",
  "replace_in_file",
  "edit",
  "write",
  // The hub-implemented ACP fs server (agents that delegate file operations
  // to the client — OpenCode `--pure`): a delegated write must hit the same
  // guard policy as a direct one.
  "fs/write_text_file",
]);
const PATCH_TOOLS = new Set(["apply_patch", "patch"]);
const DELETE_TOOLS = new Set(["delete_file"]);
const NETWORK_TOOLS = new Set(["webfetch", "web_fetch", "fetch_web_content", "websearch", "web_search"]);

export function guardInputFromToolCall(toolName: string, input: unknown, workspaceRoot?: string): GuardCheckInput | undefined {
  const base = workspaceRoot === undefined ? {} : { workspaceRoot };
  if (SHELL_TOOLS.has(toolName)) {
    return { action: "shell", command: shellCommandFromInput(input), ...base };
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const record = inputRecord(input);
    // Extraction keys cover every host's shapes: path/filePath/file_path,
    // content/newString — content-bearing edits must never reach the guard
    // path- or content-blind.
    const path = firstString(record, ["path", "filePath", "file_path"]);
    const content = firstString(record, ["content", "newString"]);
    const patchText = firstString(record, ["patchText", "patch", "diff"]);
    return {
      action: "file_write",
      ...(path === undefined ? {} : { path }),
      ...(content === undefined ? {} : { content }),
      ...(patchText === undefined ? {} : { patchText }),
      ...base,
    };
  }
  if (PATCH_TOOLS.has(toolName)) {
    const record = inputRecord(input);
    const path = firstString(record, ["path", "filePath", "file_path"]);
    const patchText = firstString(record, ["patchText", "patch", "diff"]);
    return {
      action: "file_write",
      ...(path === undefined ? {} : { path }),
      ...(patchText === undefined ? {} : { patchText }),
      ...base,
    };
  }
  if (DELETE_TOOLS.has(toolName)) {
    const record = inputRecord(input);
    const path = firstString(record, ["path", "filePath", "file_path"]);
    return {
      action: "file_write",
      ...(path === undefined ? {} : { path }),
      ...base,
    };
  }
  if (NETWORK_TOOLS.has(toolName)) {
    const record = inputRecord(input);
    const url = firstString(record, ["url", "input"]);
    return {
      action: "network",
      ...(url === undefined ? {} : { command: url }),
      ...base,
    };
  }
  return undefined;
}

function firstString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function inputRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  return input as Record<string, unknown>;
}

function shellCommandFromInput(input: unknown): string {
  if (typeof input === "string") return input;
  const record = inputRecord(input);
  if (record === undefined) return "";
  if (typeof record.command === "string") return record.command;
  if (record.command !== null && typeof record.command === "object") {
    const structured = record.command as { command?: string; args?: string[] };
    return [structured.command, ...(structured.args ?? [])].filter(Boolean).join(" ");
  }
  if (Array.isArray(record.commands)) {
    return record.commands
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry !== null && typeof entry === "object") {
          const structured = entry as { command?: string; args?: string[] };
          return [structured.command, ...(structured.args ?? [])].filter(Boolean).join(" ");
        }
        return "";
      })
      .filter((command) => command.length > 0)
      .join("; ");
  }
  return "";
}
