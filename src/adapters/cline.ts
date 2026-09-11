import type { PolicyDecision, TaskId } from "../kernel/contracts.js";
import {
  hostCapabilities,
  type ProposedToolAction,
  type ToolCapability,
  type TranslatingHostAdapter,
} from "./host.js";

export interface ClineHostAdapterOptions {
  readonly sessionId: string;
  readonly taskId: TaskId | (() => TaskId);
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
    const capability = stricterCapability(builtInCapability, customCapability) ?? "mutation";
    return {
      sessionId: this.options.sessionId,
      taskId: typeof this.options.taskId === "function" ? this.options.taskId() : this.options.taskId,
      tool: input.tool.name,
      capability,
      requiredCapabilities: distinctCapabilities(builtInCapability, customCapability, capability),
      mutating: capability === "mutation" || capability === "process" || this.options.isMutatingTool(input.tool.name),
      subjects: extractSubjects(input.tool.name, input.input),
      input: input.input,
    };
  }

  beforeToolControl(decision: PolicyDecision): { stop: true; reason: string } | undefined {
    return decision.kind === "deny" ? { stop: true, reason: decision.reason } : undefined;
  }
}

function clineCapability(tool: string): ToolCapability | undefined {
  if (tool === "run_command" || tool === "run_commands" || tool === "execute_command") return "process";
  if (tool === "read_files" || tool === "read_file" || tool === "search_codebase") return "read";
  if (tool === "fetch_web_content") return "network";
  if (tool === "editor" || tool === "write_file" || tool === "write_to_file" || tool === "apply_patch") return "mutation";
  return undefined;
}

function stricterCapability(builtIn: ToolCapability | undefined, custom: ToolCapability | undefined): ToolCapability | undefined {
  if (builtIn === "process") return "process";
  if (builtIn === "mutation") return "mutation";
  if (builtIn === "network") return "network";
  return custom ?? builtIn;
}

function distinctCapabilities(first: ToolCapability | undefined, second: ToolCapability | undefined, fallback: ToolCapability): readonly ToolCapability[] {
  if (first === undefined) return second === undefined ? [fallback] : [second];
  return second === undefined || second === first ? [first] : [first, second];
}

function isBeforeToolEvent(input: unknown): input is { tool: { name: string }; input: unknown } {
  if (typeof input !== "object" || input === null) return false;
  const value = input as Record<string, unknown>;
  if (typeof value.tool !== "object" || value.tool === null) return false;
  return typeof (value.tool as Record<string, unknown>).name === "string" && "input" in value;
}

function extractSubjects(tool: string, input: unknown): readonly string[] {
  if (tool === "read_files" || tool === "read_file") return extractReadSubjects(input);
  if (tool === "apply_patch") return extractPatchSubjects(input);
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
  if (tool === "editor" || tool === "write_file" || tool === "write_to_file") {
    throw new TypeError("invalid Cline tool subject");
  }
  return [];
}

function extractReadSubjects(input: unknown): readonly string[] {
  if (typeof input === "string") {
    if (input.length === 0) throw new TypeError("invalid Cline tool subject");
    return [input];
  }
  if (Array.isArray(input)) return input.flatMap(extractReadSubjects);
  if (typeof input !== "object" || input === null) throw new TypeError("invalid Cline tool subject");
  const value = input as Record<string, unknown>;
  if ("path" in value) {
    if (typeof value.path !== "string" || value.path.length === 0) throw new TypeError("invalid Cline tool subject");
    return [value.path];
  }
  for (const key of ["files", "paths", "file_paths"]) {
    if (!(key in value)) continue;
    return extractReadSubjects(value[key]);
  }
  throw new TypeError("invalid Cline tool subject");
}

function extractPatchSubjects(input: unknown): readonly string[] {
  const patch = typeof input === "string"
    ? input
    : typeof input === "object" && input !== null && typeof (input as Record<string, unknown>).input === "string"
      ? (input as Record<string, string>).input
      : undefined;
  if (patch === undefined) throw new TypeError("invalid Cline apply_patch input");
  const subjects = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1]!);
  if (subjects.length === 0) throw new TypeError("invalid Cline apply_patch subjects");
  return subjects;
}
