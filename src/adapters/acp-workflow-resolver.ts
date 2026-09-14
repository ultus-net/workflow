import type { PolicyDecision } from "../kernel/contracts.js";
import type { AcpHostAdapter } from "./acp.js";
import type { AcpPermissionCorrelation, AcpPermissionRequestParams } from "./acp-permission.js";
import { correlateAcpPermissionRequest } from "./acp-permission.js";
import type { AcpPermissionDecision } from "./acp-subprocess.js";
import type { ProposedToolAction, ToolCapability } from "./host.js";

export interface WorkflowAcpPermissionResolverOptions {
  readonly adapter: Pick<AcpHostAdapter, "proposalFromBeforeTool">;
  readonly correlation: AcpPermissionCorrelation;
  authorize(action: ProposedToolAction): Promise<PolicyDecision> | PolicyDecision;
}

export function createWorkflowAcpPermissionResolver(
  options: WorkflowAcpPermissionResolverOptions,
): (request: AcpPermissionRequestParams) => Promise<AcpPermissionDecision> {
  return async (request) => {
    const correlated = correlateAcpPermissionRequest(request, options.correlation);
    const validatedLocations = correlated.toolCall.locations.map((location) => ({ path: location.path as string }));
    if (isUnknownMutationTool(correlated.toolCall.name, correlated.toolCall.capability)) {
      throw new TypeError(`unknown ACP mutation tool: ${correlated.toolCall.name}`);
    }
    const locations = authorizationLocations(correlated.toolCall.name, correlated.toolCall.rawInput, validatedLocations);
    const toolCall = {
      name: correlated.toolCall.name,
      kind: correlated.toolCall.kind ?? "other",
      ...(correlated.toolCall.capability ? { capability: correlated.toolCall.capability } : {}),
      ...(correlated.toolCall.rawInput === undefined ? {} : { rawInput: correlated.toolCall.rawInput }),
      locations,
    };
    const proposal = options.adapter.proposalFromBeforeTool({
      sessionId: correlated.sessionId,
      taskId: correlated.taskId,
      toolCall,
    });
    const decision = await options.authorize(proposal);
    return decision.kind === "allow" ? { kind: "allow" } : { kind: "deny", reason: decision.reason };
  };
}

function authorizationLocations(
  toolName: string,
  rawInput: unknown,
  locations: readonly { readonly path: string }[],
): readonly { readonly path: string }[] {
  if (locations.length > 0) return locations;
  const subjects = rawSubjects(toolName, rawInput);
  if (subjects.length > 0) return subjects.map((path) => ({ path }));
  if (isSubjectBearingTool(toolName)) {
    throw new TypeError(`ACP permission request for ${toolName} has no authorization subject`);
  }
  return [];
}

// Cline 3.0.61 approval-gated tool surface (apps/vscode/src/sdk/sdk-tool-policies.ts
// and apps/cli/src/acp/tool-utils.ts), mirrored so every observed gated tool is
// recognized. Subjects are workspace paths only — the kernel checks every subject
// with pathWithinWorkspace, so commands, URLs, and queries stay in `input` for
// capability policy instead of becoming pseudo-paths.
const PATH_SUBJECT_TOOLS = new Set([
  "read_file",
  "list_files",
  "list_code_definition_names",
  "search_files",
  "editor",
  "apply_patch",
  "write_file",
  "replace_in_file",
  "write_to_file",
  "delete_file",
]);
const PROCESS_TOOLS = new Set(["run_commands", "execute_command", "shell", "bash"]);
const NON_SUBJECT_TOOLS = new Set(["search_codebase", "fetch_web_content", "web_fetch", "web_search"]);

function rawSubjects(toolName: string, rawInput: unknown): string[] {
  if (PROCESS_TOOLS.has(toolName)) return processSubjects(toolName, rawInput);
  if (NON_SUBJECT_TOOLS.has(toolName)) return [];
  if (!isRecord(rawInput)) return [];
  if (toolName === "read_files") return readFilesSubjects(rawInput);
  if (PATH_SUBJECT_TOOLS.has(toolName)) {
    return typeof rawInput.path === "string" && rawInput.path.trim().length > 0 ? [rawInput.path] : [];
  }
  return [];
}

function readFilesSubjects(rawInput: Record<string, unknown>): string[] {
  if (Array.isArray(rawInput.files)) {
    return rawInput.files.map((file) => {
      if (!isRecord(file) || typeof file.path !== "string" || file.path.trim().length === 0) {
        throw new TypeError("invalid ACP read_files path");
      }
      return file.path;
    });
  }
  for (const key of ["file_paths", "paths"]) {
    if (Array.isArray(rawInput[key])) {
      return (rawInput[key] as unknown[]).map((entry) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          throw new TypeError("invalid ACP read_files path");
        }
        return entry;
      });
    }
  }
  return [];
}

// Process tools must carry a usable command in the input, but the command text is
// never a subject; the optional cwd is the only path subject.
function processSubjects(toolName: string, rawInput: unknown): string[] {
  validateCommandInput(toolName, rawInput);
  if (isRecord(rawInput) && typeof rawInput.cwd === "string" && rawInput.cwd.trim().length > 0) {
    return [rawInput.cwd];
  }
  return [];
}

function validateCommandInput(toolName: string, rawInput: unknown): void {
  if (typeof rawInput === "string") {
    if (rawInput.trim().length === 0) throw noCommandError(toolName);
    return;
  }
  if (!isRecord(rawInput)) throw noCommandError(toolName);
  if ("command" in rawInput) {
    if (typeof rawInput.command !== "string" || rawInput.command.trim().length === 0) throw noCommandError(toolName);
    return;
  }
  if ("commands" in rawInput) {
    if (!Array.isArray(rawInput.commands) || rawInput.commands.length === 0) throw noCommandError(toolName);
    for (const entry of rawInput.commands) {
      if (typeof entry === "string" && entry.trim().length > 0) continue;
      if (isRecord(entry) && typeof entry.command === "string" && entry.command.trim().length > 0) continue;
      throw new TypeError(`invalid ACP ${toolName} command entry`);
    }
    return;
  }
  throw noCommandError(toolName);
}

function noCommandError(toolName: string): TypeError {
  return new TypeError(`ACP permission request for ${toolName} has no command`);
}

function isUnknownMutationTool(toolName: string, capability: ToolCapability | undefined): boolean {
  return !isRecognizedTool(toolName) && (capability === "mutation" || capability === "process" || capability === "network" || capability === "credentials");
}

function isRecognizedTool(toolName: string): boolean {
  return isSubjectBearingTool(toolName) || PROCESS_TOOLS.has(toolName) || NON_SUBJECT_TOOLS.has(toolName);
}

function isSubjectBearingTool(toolName: string): boolean {
  return toolName === "read_files" || PATH_SUBJECT_TOOLS.has(toolName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
