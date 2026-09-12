import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { normalizeMcpEvidence, type McpCapability, type McpProvider } from "../adapters/mcp.js";
import type { Evidence } from "../kernel/contracts.js";

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

export async function createWorkflowGuardMcpProvider(options: { serverPath: string }): Promise<WorkflowGuardProvider> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverPath],
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

/** Maps a guard decision to normalized MCP evidence for the policy subject. */
/** Resolves the vendored workflow-guard-mcp server entrypoint, building first if needed. */
export function defaultToolboxGuardServerPath(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const serverPath = resolve(root, "mcp-toolbox", "apps", "workflow-guard-mcp", "dist", "server.js");
  if (!existsSync(serverPath)) {
    throw new Error(`workflow-guard-mcp is not built; run: npm run toolbox:build (expected ${serverPath})`);
  }
  return serverPath;
}

export function createDefaultToolboxGuardProvider(): Promise<WorkflowGuardProvider> {
  return createWorkflowGuardMcpProvider({ serverPath: defaultToolboxGuardServerPath() });
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
