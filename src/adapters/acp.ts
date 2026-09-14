import type { PolicyDecision, TaskId } from "../kernel/contracts.js";
import { hostCapabilities, type ProposedToolAction, type ToolCapability, type TranslatingHostAdapter } from "./host.js";

interface AcpCorrelatedPermission {
  readonly sessionId: string;
  readonly taskId: TaskId;
  readonly toolCall: {
    readonly name: string;
    readonly kind?: string;
    readonly capability?: ToolCapability;
    readonly rawInput?: unknown;
    readonly locations?: readonly { readonly path?: string }[];
  };
}

const KNOWN_READ_TOOLS: ReadonlySet<string> = new Set(["read", "read_file", "read_files", "search", "glob", "grep", "list"]);

export class AcpHostAdapter implements TranslatingHostAdapter<AcpCorrelatedPermission, { outcome: "reject_once"; reason: string }> {
  readonly capabilities;

  constructor(options: { readonly authoritativePermissions: boolean }) {
    this.capabilities = hostCapabilities({
      transport: "acp",
      authoritativePreMutation: options.authoritativePermissions,
    });
  }

  proposalFromBeforeTool(input: AcpCorrelatedPermission): ProposedToolAction {
    assertValidEvent(input);
    const locations = input.toolCall.locations ?? [];
    if (locations.some((location) => typeof location.path !== "string" || location.path.length === 0)) {
      throw new TypeError("invalid ACP tool location");
    }
    // A host labelling a write as `read`/`search` must not narrow the gate:
    // non-mutating only when the kind and the tool name both say read.
    const mutating = !(isReadKind(input.toolCall.kind) && KNOWN_READ_TOOLS.has(input.toolCall.name));
    const subjects = subjectsFrom(input.toolCall, locations);
    const builtInCapability = acpCapability(input.toolCall.kind);
    const capability = stricterCapability(builtInCapability, input.toolCall.capability);
    // Mutation subjects gate workspace confinement; process proposals are
    // governed by the process capability gate instead and need no subjects.
    if (mutating && capability !== "process" && subjects.length === 0) {
      throw new TypeError("invalid ACP tool subject");
    }
    return {
      sessionId: input.sessionId,
      taskId: input.taskId,
      tool: input.toolCall.name,
      capability,
      requiredCapabilities: distinctCapabilities(builtInCapability, input.toolCall.capability),
      mutating,
      subjects,
      input: input.toolCall.rawInput,
    };
  }

  beforeToolControl(decision: PolicyDecision): { outcome: "reject_once"; reason: string } | undefined {
    return decision.kind === "deny" ? { outcome: "reject_once", reason: decision.reason } : undefined;
  }
}

function assertValidEvent(input: AcpCorrelatedPermission): void {
  const event = input as Partial<AcpCorrelatedPermission> | null;
  if (typeof event !== "object" || event === null) throw new TypeError("invalid ACP permission event");
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) throw new TypeError("invalid ACP permission event");
  if (typeof event.taskId !== "string" || event.taskId.length === 0) throw new TypeError("invalid ACP permission event");
  const toolCall = event.toolCall as Partial<AcpCorrelatedPermission["toolCall"]> | undefined;
  if (typeof toolCall !== "object" || toolCall === null || typeof toolCall.name !== "string" || toolCall.name.length === 0) {
    throw new TypeError("invalid ACP permission event");
  }
}

function isReadKind(kind: string | undefined): boolean {
  return kind === "read" || kind === "search";
}

function subjectsFrom(
  toolCall: AcpCorrelatedPermission["toolCall"],
  locations: readonly { readonly path?: string }[],
): readonly string[] {
  const located = locations.map((location) => location.path as string);
  if (located.length > 0) return located;
  const input = toolCall.rawInput;
  if (typeof input !== "object" || input === null) return [];
  for (const key of ["path", "filePath", "file_path"]) {
    const candidate = (input as Record<string, unknown>)[key];
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new TypeError("invalid ACP tool subject");
    }
    return [candidate];
  }
  return [];
}

function acpCapability(kind: string | undefined): ToolCapability {
  if (kind === "execute" || kind === "process") return "process";
  if (kind === "read" || kind === "search") return "read";
  return "mutation";
}

function stricterCapability(builtIn: ToolCapability, explicit: ToolCapability | undefined): ToolCapability {
  if (builtIn === "process" || builtIn === "mutation" || builtIn === "network") return builtIn;
  return explicit ?? builtIn;
}

function distinctCapabilities(first: ToolCapability, second: ToolCapability | undefined): readonly ToolCapability[] {
  return second === undefined || second === first ? [first] : [first, second];
}
