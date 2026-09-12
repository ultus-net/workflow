#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { checkPolicy, type GuardCheckInput, type GuardDecision } from "./policy.js";

export interface ClaudePreToolUseInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface ClaudeHookOutput {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "allow" | "deny" | "ask"; permissionDecisionReason: string };
  systemMessage: string;
}

function stringField(input: Record<string, unknown>, name: string): string | undefined {
  return typeof input[name] === "string" ? input[name] : undefined;
}

export function guardInputFromClaude(input: ClaudePreToolUseInput): GuardCheckInput | undefined {
  const toolInput = input.tool_input ?? {};
  const workspaceRoot = input.cwd;
  if (!workspaceRoot) return undefined;
  if (input.tool_name === "Bash") {
    const command = stringField(toolInput, "command");
    return command !== undefined ? { action: "shell", command, workspaceRoot } : undefined;
  }
  if (input.tool_name === "Write") {
    const path = stringField(toolInput, "file_path");
    const content = stringField(toolInput, "content");
    return path && content !== undefined ? { action: "file_write", path, content, workspaceRoot } : undefined;
  }
  if (input.tool_name === "Edit") {
    const path = stringField(toolInput, "file_path");
    const oldString = stringField(toolInput, "old_string");
    const newString = stringField(toolInput, "new_string");
    return path && oldString !== undefined && newString !== undefined ? { action: "file_write", path, content: newString, workspaceRoot } : undefined;
  }
  if (input.tool_name === "NotebookEdit") {
    const path = stringField(toolInput, "notebook_path");
    const newSource = stringField(toolInput, "new_source");
    return path && newSource !== undefined ? { action: "file_write", path, content: newSource, workspaceRoot } : undefined;
  }
  return undefined;
}

export function claudeOutputFor(decision: GuardDecision): ClaudeHookOutput {
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.decision, permissionDecisionReason: decision.reason },
    systemMessage: `workflow-guard: ${decision.policy}: ${decision.reason}`,
  };
}

let consecutiveDenials = 0;

export function resetClaudeHookFailures(): void {
  consecutiveDenials = 0;
}

export function evaluateClaudePreToolUse(input: ClaudePreToolUseInput): ClaudeHookOutput {
  if (input.hook_event_name !== "PreToolUse") return claudeOutputFor({ decision: "deny", policy: "invalid-hook-event", reason: "Claude hook adapter only accepts PreToolUse events." });
  const guardInput = guardInputFromClaude(input);
  if (!guardInput) return claudeOutputFor({ decision: "deny", policy: "unsupported-tool-input", reason: "Guarded Claude tool input is missing required fields or is unsupported." });
  const decision = checkPolicy({ ...guardInput, failureCount: consecutiveDenials });
  if (decision.decision === "deny") {
    consecutiveDenials += 1;
  } else if (decision.decision === "allow") {
    consecutiveDenials = 0;
  }
  return claudeOutputFor(decision);
}

async function main(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ClaudePreToolUseInput;
    process.stdout.write(`${JSON.stringify(evaluateClaudePreToolUse(input))}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid hook input";
    process.stdout.write(`${JSON.stringify(claudeOutputFor({ decision: "deny", policy: "invalid-hook-input", reason }))}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
