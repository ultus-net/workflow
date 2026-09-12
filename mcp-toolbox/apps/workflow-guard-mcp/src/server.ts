#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { checkPolicy } from "./policy.js";

const server = new McpServer(
  { name: "workflow-guard-mcp", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

server.registerTool(
  "guard_check",
  {
    description: "Proactively call before a guarded coding-agent action when the host does not enforce this policy itself. Modifications require an active task, a feature branch, and a prior same-session read. Advisory unless the host wires the result into enforcement.",
    inputSchema: {
      action: z.enum(["shell", "file_write", "git", "network", "mcp"]),
      command: z.string().optional(),
      path: z.string().optional(),
      workspaceRoot: z.string().optional(),
      content: z.string().optional(),
      patchText: z.string().optional(),
      currentBranch: z.string().optional(),
      protectedBranches: z.array(z.string()).optional(),
      trustedRole: z.string().optional(),
      toolName: z.string().optional(),
      failureCount: z.number().optional(),
    },
    outputSchema: {
      decision: z.enum(["allow", "deny", "ask"]),
      policy: z.string(),
      reason: z.string(),
    },
  },
  async (input) => {
    const decision = checkPolicy(input);
    // Stream the verdict as a leveled MCP log notification so hosts that
    // surface MCP logging (e.g. the Workflow monitoring TUI) show guard
    // activity in the session stream.
    await server.server.sendLoggingMessage({
      level: decision.decision === "deny" ? "error" : decision.decision === "ask" ? "warning" : "debug",
      logger: "workflow-guard-mcp",
      data: {
        tool: "guard_check",
        phase: "verdict",
        verdict: decision.decision,
        policy: decision.policy,
        reason: decision.reason,
      },
    });
    return {
      content: [{ type: "text", text: JSON.stringify(decision) }],
      structuredContent: {
        decision: decision.decision,
        policy: decision.policy,
        reason: decision.reason,
      },
    };
  },
);

server.registerTool(
  "guard_status",
  {
    description: "Proactively call at the start of guarded repository work and when a policy denial leaves the required next step unclear. Reports capabilities, operational preconditions, enforcement boundaries, and recommended lifecycle actions.",
    inputSchema: {},
  },
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        mode: "policy-advisor",
        enforcement: "host-dependent",
        executesActions: false,
        preconditions: {
          modifications: "Modifications require an active task in todowrite (status pending or in_progress), a feature branch (edits on main/master are blocked), and a prior read of existing files in the current session.",
          finalization: "Marking every task completed triggers the finalization gate - fresh verification evidence (test run) is required after the last mutation, and protected-branch/conflict checks apply.",
        },
        circuitBreaker: {
          threshold: 2,
          guidance: "Repeated failures detected in this session. Stop attempting alternative workarounds or shell laundering. Address the required step above directly.",
        },
        recommendedActions: [
          "Before modifying files, ensure an active task exists, work on a feature branch, and read the existing files you will change.",
          "After the final mutation, run fresh verification before marking all work complete.",
          "Before finalizing or handing off changed work, inspect current review and verification accountability when those MCP products are available.",
          "If a policy denies an action, satisfy the stated precondition directly instead of trying alternate command forms.",
        ],
      }, null, 2),
    }],
  }),
);

await server.connect(new StdioServerTransport());
