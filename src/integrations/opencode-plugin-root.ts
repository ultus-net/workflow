import type { OpenCodeHostAdapter } from "../adapters/opencode.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { PermissionBroker } from "../ui/permission-broker.js";
import type { WorkflowGuardProvider } from "./mcp-toolbox-guard.js";
import { createWorkflowOpenCodePlugin, type WorkflowOpenCodePlugin } from "./opencode-plugin.js";

/**
 * P6 (issue #285): the production composition root for the in-process OpenCode
 * plugin factory. The factory (`createWorkflowOpenCodePlugin`) accepts an
 * `OperatorAskHold`; this root composes one from a `PermissionBroker`, so a
 * guard `ask` parks on the broker's ONE pending/answer transport rather than
 * failing closed.
 *
 * The plugin runs in the AGENT-HOST process, so the broker must be that
 * process's own: the returned `permissionBroker` IS the same-process answer
 * surface. A host serves it directly (`pendingRequest()`/`pendingAsks()` +
 * `answer()`/`answerAsk()`) or mounts the hub's `/api/permission` route shape
 * against it. This root composes only in-process objects — it invents no
 * cross-process plumbing.
 */
export interface WorkflowOpenCodePluginRootOptions {
  /** The session key the plugin's held asks park under (the host's answer
   * surface scopes to it); omitted → the keyless channel's unscoped shape. */
  readonly sessionKey?: string;
  /** Compose against an existing broker (a host that already serves its answer
   * route); a fresh broker is created otherwise. */
  readonly broker?: PermissionBroker;
}

export interface WorkflowOpenCodePluginRoot {
  readonly plugin: WorkflowOpenCodePlugin;
  /**
   * The same-process answer surface: the broker the plugin's hold is derived
   * from. The host owns it and answers the parked ask through it.
   */
  readonly permissionBroker: PermissionBroker;
}

export function createWorkflowOpenCodePluginRoot(
  application: WorkflowApplication,
  adapter: OpenCodeHostAdapter,
  guard?: WorkflowGuardProvider,
  options: WorkflowOpenCodePluginRootOptions = {},
): WorkflowOpenCodePluginRoot {
  const permissionBroker = options.broker ?? new PermissionBroker();
  const plugin = createWorkflowOpenCodePlugin(application, adapter, guard, permissionBroker.askHold(options.sessionKey));
  return { plugin, permissionBroker };
}
