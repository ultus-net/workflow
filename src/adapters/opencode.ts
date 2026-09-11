import type { PolicyDecision, TaskId } from "../kernel/contracts.js";
import { hostCapabilities, type ProposedToolAction, type ToolCapability, type TranslatingHostAdapter } from "./host.js";

export interface OpenCodeHostAdapterOptions {
  readonly taskId: TaskId | (() => TaskId);
  readonly capabilityForTool?: (tool: string) => ToolCapability;
}

export interface OpenCodeBeforeToolInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly callID: string;
}

export interface OpenCodeBeforeToolOutput {
  readonly args: unknown;
}

export class OpenCodeHostAdapter implements TranslatingHostAdapter<unknown, never> {
  readonly capabilities = hostCapabilities({ transport: "native", authoritativePreMutation: true });

  constructor(readonly options: OpenCodeHostAdapterOptions) {}

  proposalFromBeforeTool(input: unknown): ProposedToolAction {
    if (!isBeforeToolEvent(input)) throw new TypeError("invalid OpenCode before-tool event");
    const builtInCapability = openCodeCapability(input.input.tool);
    const customCapability = this.options.capabilityForTool?.(input.input.tool);
    const capability = stricterCapability(builtInCapability, customCapability) ?? "mutation";
    return {
      sessionId: input.input.sessionID,
      taskId: typeof this.options.taskId === "function" ? this.options.taskId() : this.options.taskId,
      tool: input.input.tool,
      capability,
      requiredCapabilities: distinctCapabilities(builtInCapability, customCapability, capability),
      mutating: capability === "mutation" || capability === "process",
      subjects: extractSubjects(input.input.tool, input.output.args),
      input: input.output.args,
    };
  }

  beforeToolControl(decision: PolicyDecision): undefined {
    void decision;
    return undefined;
  }
}

function openCodeCapability(tool: string): ToolCapability | undefined {
  if (tool === "bash") return "process";
  if (tool === "read" || tool === "glob" || tool === "grep" || tool === "list") return "read";
  if (tool === "webfetch") return "network";
  if (tool === "edit" || tool === "write" || tool === "patch" || tool === "apply_patch") return "mutation";
  return undefined;
}

function stricterCapability(builtIn: ToolCapability | undefined, custom: ToolCapability | undefined): ToolCapability | undefined {
  if (builtIn === "process" || builtIn === "mutation" || builtIn === "network") return builtIn;
  return custom ?? builtIn;
}

function distinctCapabilities(first: ToolCapability | undefined, second: ToolCapability | undefined, fallback: ToolCapability): readonly ToolCapability[] {
  if (first === undefined) return second === undefined ? [fallback] : [second];
  return second === undefined || second === first ? [first] : [first, second];
}

function isBeforeToolEvent(input: unknown): input is { input: OpenCodeBeforeToolInput; output: OpenCodeBeforeToolOutput } {
  if (typeof input !== "object" || input === null) return false;
  const value = input as Record<string, unknown>;
  if (typeof value.input !== "object" || value.input === null || typeof value.output !== "object" || value.output === null) return false;
  const hook = value.input as Record<string, unknown>;
  const output = value.output as Record<string, unknown>;
  return typeof hook.tool === "string" && hook.tool.length > 0
    && typeof hook.sessionID === "string" && hook.sessionID.length > 0
    && typeof hook.callID === "string" && hook.callID.length > 0
    && "args" in output;
}

function extractSubjects(tool: string, input: unknown): readonly string[] {
  if (tool === "apply_patch" || tool === "patch") return extractPatchSubjects(input);
  const requiresPath = tool === "edit" || tool === "write" || tool === "read";
  if (typeof input !== "object" || input === null) {
    if (requiresPath) throw new TypeError("invalid OpenCode tool subject");
    return [];
  }
  const value = input as Record<string, unknown>;
  for (const key of ["filePath", "path"]) {
    if (!(key in value)) continue;
    const candidate = value[key];
    if (typeof candidate !== "string" || candidate.length === 0) throw new TypeError("invalid OpenCode tool subject");
    return [candidate];
  }
  if (requiresPath) throw new TypeError("invalid OpenCode tool subject");
  return [];
}

function extractPatchSubjects(input: unknown): readonly string[] {
  const value = typeof input === "object" && input !== null ? input as Record<string, unknown> : undefined;
  const patch = typeof input === "string" ? input
    : typeof value?.patchText === "string" ? value.patchText
      : typeof value?.input === "string" ? value.input
        : undefined;
  if (patch === undefined) throw new TypeError("invalid OpenCode patch input");
  const subjects = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1]!);
  if (subjects.length === 0) throw new TypeError("invalid OpenCode patch subjects");
  return subjects;
}
