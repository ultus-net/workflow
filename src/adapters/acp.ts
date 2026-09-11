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

export class AcpHostAdapter implements TranslatingHostAdapter<AcpCorrelatedPermission, { outcome: "reject_once"; reason: string }> {
  readonly capabilities;

  constructor(options: { readonly authoritativePermissions: boolean }) {
    this.capabilities = hostCapabilities({
      transport: "acp",
      authoritativePreMutation: options.authoritativePermissions,
    });
  }

  proposalFromBeforeTool(input: AcpCorrelatedPermission): ProposedToolAction {
    if (!input.sessionId || !input.toolCall.name) throw new TypeError("invalid ACP permission event");
    const locations = input.toolCall.locations ?? [];
    if (locations.some((location) => typeof location.path !== "string" || location.path.length === 0)) {
      throw new TypeError("invalid ACP tool location");
    }
    const subjects = locations.map((location) => location.path as string);
    const builtInCapability = acpCapability(input.toolCall.kind);
    const capability = stricterCapability(builtInCapability, input.toolCall.capability);
    return {
      sessionId: input.sessionId,
      taskId: input.taskId,
      tool: input.toolCall.name,
      capability,
      requiredCapabilities: distinctCapabilities(builtInCapability, input.toolCall.capability),
      mutating: input.toolCall.kind !== "read" && input.toolCall.kind !== "search",
      subjects,
      input: input.toolCall.rawInput,
    };
  }

  beforeToolControl(decision: PolicyDecision): { outcome: "reject_once"; reason: string } | undefined {
    return decision.kind === "deny" ? { outcome: "reject_once", reason: decision.reason } : undefined;
  }
}

function acpCapability(kind: string | undefined): ToolCapability {
  if (kind === "execute" || kind === "process") return "process";
  if (kind === "read" || kind === "search") return "read";
  return "mutation";
}

function stricterCapability(builtIn: ToolCapability, explicit: ToolCapability | undefined): ToolCapability {
  if (builtIn === "process") return "process";
  return explicit ?? builtIn;
}

function distinctCapabilities(first: ToolCapability, second: ToolCapability | undefined): readonly ToolCapability[] {
  return second === undefined || second === first ? [first] : [first, second];
}
