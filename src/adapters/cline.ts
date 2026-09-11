import type { PolicyDecision, TaskId } from "../kernel/contracts.js";
import {
  hostCapabilities,
  type ProposedToolAction,
  type ToolCapability,
  type TranslatingHostAdapter,
} from "./host.js";

export interface ClineHostAdapterOptions {
  readonly sessionId: string;
  readonly taskId: TaskId;
  readonly isMutatingTool: (tool: string) => boolean;
  readonly capabilityForTool?: (tool: string) => ToolCapability;
  readonly authoritativePreMutation?: boolean;
}

export class ClineHostAdapter implements TranslatingHostAdapter<unknown, { stop: true; reason: string }> {
  readonly capabilities;

  constructor(readonly options: ClineHostAdapterOptions) {
    this.capabilities = hostCapabilities({
      transport: "native",
      authoritativePreMutation: options.authoritativePreMutation ?? false,
    });
  }

  proposalFromBeforeTool(input: unknown): ProposedToolAction {
    if (!isBeforeToolEvent(input)) {
      throw new TypeError("invalid Cline beforeTool event");
    }
    const builtInCapability = clineCapability(input.tool.name);
    const customCapability = this.options.capabilityForTool?.(input.tool.name);
    const capability = stricterCapability(builtInCapability, customCapability);
    return {
      sessionId: this.options.sessionId,
      taskId: this.options.taskId,
      tool: input.tool.name,
      capability,
      requiredCapabilities: distinctCapabilities(builtInCapability, customCapability),
      mutating: this.options.isMutatingTool(input.tool.name),
      subjects: extractSubjects(input.input),
      input: input.input,
    };
  }

  beforeToolControl(decision: PolicyDecision): { stop: true; reason: string } | undefined {
    return decision.kind === "deny" ? { stop: true, reason: decision.reason } : undefined;
  }
}

function clineCapability(tool: string): ToolCapability {
  if (tool === "run_command" || tool === "run_commands" || tool === "execute_command") return "process";
  return "mutation";
}

function stricterCapability(builtIn: ToolCapability, custom: ToolCapability | undefined): ToolCapability {
  if (builtIn === "process") return "process";
  return custom ?? builtIn;
}

function distinctCapabilities(first: ToolCapability, second: ToolCapability | undefined): readonly ToolCapability[] {
  return second === undefined || second === first ? [first] : [first, second];
}

function isBeforeToolEvent(input: unknown): input is { tool: { name: string }; input: unknown } {
  if (typeof input !== "object" || input === null) return false;
  const value = input as Record<string, unknown>;
  if (typeof value.tool !== "object" || value.tool === null) return false;
  return typeof (value.tool as Record<string, unknown>).name === "string" && "input" in value;
}

function extractSubjects(input: unknown): readonly string[] {
  if (typeof input !== "object" || input === null) return [];
  const value = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    if (!(key in value)) continue;
    const candidate = value[key];
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new TypeError("invalid Cline tool subject");
    }
    return [candidate];
  }
  return [];
}
