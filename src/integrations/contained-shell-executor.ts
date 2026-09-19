import type { HostCapabilities, ProposedToolAction } from "../application/host.js";
import type { WorkflowContainedProcess } from "../containment/workflow-process.js";
import type { TaskId } from "../kernel/contracts.js";

/**
 * Host-neutral contained shell execution: runs a command through
 * `WorkflowContainedProcess` under an application-authorized process proposal.
 * Replaces the vendored-Cline `createWorkflowClineShellExecutor` so the hub's
 * diff sourcing / test execution do not depend on a concrete agent SDK
 * (W050 step 6).
 */

export interface ContainedShellCommandInput {
  readonly command: string;
  readonly args?: readonly string[];
}

export type WorkflowContainedShellExecutor = (
  command: string | ContainedShellCommandInput,
  cwd: string,
  context: unknown,
) => Promise<string>;

export type ContainedShellExitErrorFactory = (exitCode: number, output: string) => Error;
export type ContainedShellObserver = (result: { exitCode: number | null; output: string }) => void;

export interface ContainedShellExecutorOptions {
  readonly capabilities: HostCapabilities;
  readonly sessionId: string;
  readonly taskId: TaskId | (() => TaskId);
  readonly commandExitError?: ContainedShellExitErrorFactory;
  readonly observe?: ContainedShellObserver;
  readonly writableWorkspace?: boolean;
}

export function createContainedShellExecutor(
  process: WorkflowContainedProcess,
  options: ContainedShellExecutorOptions,
): WorkflowContainedShellExecutor {
  if (options.capabilities.enforcementLevel !== "enforced") {
    throw new TypeError("contained shell executor requires authoritative pre-mutation interception");
  }
  const writableWorkspace = options.writableWorkspace ?? true;
  const commandExitError = options.commandExitError ?? ((exitCode, output) =>
    new Error(`contained command exited with code ${exitCode}: ${output}`));

  return async (command, cwd) => {
    const request = containedRequest(command, cwd, writableWorkspace);
    const proposal: ProposedToolAction = {
      sessionId: options.sessionId,
      taskId: typeof options.taskId === "function" ? options.taskId() : options.taskId,
      tool: "execute_command",
      capability: "process",
      requiredCapabilities: ["process"],
      mutating: true,
      // Command text is never a kernel subject: subjects are workspace-relative
      // paths, and this proposal has none.
      subjects: [],
      input: { executable: request.executable, args: request.args },
    };
    const result = await process.execute(writableWorkspace ? proposal : { ...proposal, mutating: false }, request);
    const output = result.stdout + result.stderr;
    options.observe?.({ exitCode: result.exitCode, output });
    if (result.exitCode !== 0) {
      if (result.exitCode === null) throw new Error(`contained command exited without an exit code: ${output}`);
      throw commandExitError(result.exitCode, output);
    }
    return output;
  };
}

function containedRequest(command: string | ContainedShellCommandInput, cwd: string, writableWorkspace: boolean) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("invalid contained shell cwd");
  if (typeof command === "string") {
    if (command.length === 0) throw new TypeError("invalid contained shell command");
    const request = {
      executable: "/bin/bash",
      args: ["-c", command],
      cwd,
      writablePaths: writableWorkspace ? [cwd] : [],
    };
    return writableWorkspace ? request : { ...request, readablePaths: [cwd] };
  }
  if (typeof command !== "object" || command === null || typeof command.command !== "string" || command.command.length === 0) {
    throw new TypeError("invalid contained structured shell command");
  }
  if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some((argument) => typeof argument !== "string"))) {
    throw new TypeError("invalid contained structured shell arguments");
  }
  const request = {
    executable: command.command,
    args: command.args ?? [],
    cwd,
    writablePaths: writableWorkspace ? [cwd] : [],
  };
  return writableWorkspace ? request : { ...request, readablePaths: [cwd] };
}
