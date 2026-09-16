import { WorkflowCodingSession } from "../application/coding-session.js";
import type { WorkflowApplication } from "../application/workflow.js";
import { createConfiguredAcpRuntime } from "../integrations/acp-runtime.js";
import { createConfiguredClineRuntime } from "../integrations/cline-runtime.js";
import { createOpenCodeSessionClient } from "../integrations/opencode-client.js";
import { OpenCodeSessionDriver } from "../integrations/opencode-session.js";
import type { SessionStyle } from "../integrations/response-style.js";
import type { SessionConfigOption } from "../ui/tui.js";
import { usageViewFromMetrics, type UsageSource } from "../ui/usage.js";

export const DRIVER_NAMES = ["cline", "opencode", "acp"] as const;
export type DriverName = (typeof DRIVER_NAMES)[number];

export interface ComposedDriver {
  readonly label: string;
  readonly session: WorkflowCodingSession;
  readonly sessionConfigOptions?: () => readonly SessionConfigOption[];
  readonly setSessionConfig?: (id: string, value: string | boolean) => Promise<void>;
  readonly setSessionStyle?: (style: SessionStyle) => void;
  /** W044: metering-proxy usage when the driver's runtime records it (acp). */
  readonly usage?: UsageSource;
  dispose(): Promise<void>;
}

export type DriverComposer = (application: WorkflowApplication, workspace: string) => Promise<ComposedDriver>;

export function driverHasAuthoritativePreMutation(name: DriverName): boolean {
  return name !== "opencode";
}

export function resolveDriverName(raw: string | undefined): DriverName {
  const name = raw ?? process.env.WORKFLOW_DRIVER ?? "cline";
  if ((DRIVER_NAMES as readonly string[]).includes(name)) return name as DriverName;
  throw new TypeError(`unknown driver '${name}' (valid: ${DRIVER_NAMES.join(", ")})`);
}

export function parseUniversalArgs(args: readonly string[]): { driver?: string; opencodeUrl?: string } {
  const out: { driver?: string; opencodeUrl?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--driver" && argument !== "--opencode-url") continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) throw new TypeError(`${argument} requires a value`);
    if (argument === "--driver") out.driver = value;
    else out.opencodeUrl = value;
    index += 1;
  }
  return out;
}

export async function composeDriver(
  name: DriverName,
  application: WorkflowApplication,
  workspace: string,
  options: { opencodeUrl: string; composers?: Partial<Record<DriverName, DriverComposer>> },
): Promise<ComposedDriver> {
  const activeTaskId = application.startInteractiveTask();
  const override = options.composers?.[name];
  if (override !== undefined) return override(application, workspace);
  if (name === "cline") {
    const runtime = await createConfiguredClineRuntime(application, workspace);
    return {
      label: "cline",
      session: runtime.session,
      setSessionStyle: (style) => runtime.setSessionStyle(style),
      dispose: () => runtime.dispose(),
    };
  }
  if (name === "opencode") {
    return {
      label: "opencode",
      session: new WorkflowCodingSession(new OpenCodeSessionDriver(createOpenCodeSessionClient(options.opencodeUrl))),
      dispose: async () => undefined,
    };
  }
  const runtime = await createConfiguredAcpRuntime(application, workspace, activeTaskId);
  return {
    label: "acp",
    session: runtime.session,
    sessionConfigOptions: () => (runtime.driver.config()?.configOptions ?? []) as readonly SessionConfigOption[],
    setSessionConfig: async (id, value) => { await runtime.driver.setConfigOption(id, value); },
    usage: () => {
      const view = usageViewFromMetrics(runtime.metrics?.());
      const violation = runtime.budgetViolation?.();
      return view === undefined && violation === undefined ? undefined : { ...(view ?? { totalTokens: 0, costUsd: 0 }), ...(violation === undefined ? {} : { budgetViolation: violation }) };
    },
    dispose: () => runtime.dispose(),
  };
}
