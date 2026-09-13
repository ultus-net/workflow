import type { ClineHostAdapter } from "../adapters/cline.js";
import type { WorkflowContainedProcess } from "../containment/workflow-process.js";

export interface ClineStructuredCommandInput {
  readonly command: string;
  readonly args?: readonly string[];
}

export type WorkflowClineShellExecutor = (
  command: string | ClineStructuredCommandInput,
  cwd: string,
  context: unknown,
) => Promise<string>;

export type ClineCommandExitErrorFactory = (exitCode: number, output: string) => Error;
export type ClineCommandObserver = (result: { exitCode: number | null; output: string }) => void;

export function createWorkflowClineShellExecutor(
  process: WorkflowContainedProcess,
  adapter: ClineHostAdapter,
  commandExitError: ClineCommandExitErrorFactory = (exitCode, output) =>
    new Error(`contained command exited with code ${exitCode}: ${output}`),
  observe?: ClineCommandObserver,
  writableWorkspace = true,
): WorkflowClineShellExecutor {
  if (adapter.capabilities.enforcementLevel !== "enforced") {
    throw new TypeError("Cline shell executor requires authoritative pre-mutation interception");
  }

  return async (command, cwd) => {
    const request = containedRequest(command, cwd, writableWorkspace);
    const proposal = adapter.proposalFromBeforeTool({
      tool: { name: "execute_command" },
      input: { executable: request.executable, args: request.args },
    });
    const result = await process.execute(writableWorkspace ? proposal : { ...proposal, mutating: false }, request);
    const output = result.stdout + result.stderr;
    observe?.({ exitCode: result.exitCode, output });
    if (result.exitCode !== 0) {
      if (result.exitCode === null) throw new Error(`contained command exited without an exit code: ${output}`);
      throw commandExitError(result.exitCode, output);
    }
    return output;
  };
}

function containedRequest(command: string | ClineStructuredCommandInput, cwd: string, writableWorkspace: boolean) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("invalid Cline shell cwd");
  if (typeof command === "string") {
    if (command.length === 0) throw new TypeError("invalid Cline shell command");
    const request = {
      executable: "/bin/bash",
      args: ["-c", command],
      cwd,
      writablePaths: writableWorkspace ? [cwd] : [],
    };
    return writableWorkspace ? request : { ...request, readablePaths: [cwd] };
  }
  if (typeof command !== "object" || command === null || typeof command.command !== "string" || command.command.length === 0) {
    throw new TypeError("invalid Cline structured shell command");
  }
  if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some((argument) => typeof argument !== "string"))) {
    throw new TypeError("invalid Cline structured shell arguments");
  }
  const request = {
    executable: command.command,
    args: command.args ?? [],
    cwd,
    writablePaths: writableWorkspace ? [cwd] : [],
  };
  return writableWorkspace ? request : { ...request, readablePaths: [cwd] };
}
