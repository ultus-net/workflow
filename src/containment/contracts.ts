import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface ContainedProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly readablePaths?: readonly string[];
  readonly writablePaths?: readonly string[];
  readonly network?: "isolated" | "host";
  readonly environment?: Readonly<Record<string, string>>;
}

export interface ContainedProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * `enforced` means the tested containment boundary was established (Linux
   * bubblewrap). `policy-only` means execution passed validation and Workflow
   * authorization but had NO isolation (non-Linux passthrough). A passthrough
   * can never claim bwrap-level enforcement.
   */
  readonly enforcement: "enforced" | "policy-only";
  readonly network: "isolated" | "host";
  readonly credentials: "cleared" | "explicit";
}

export interface ProcessContainment {
  /**
   * `enforced` means the backend establishes a real OS isolation boundary
   * (Linux bubblewrap). `policy-only` means requests are validated but run
   * with NO isolation. Launchers that require an enforced boundary must check
   * this marker instead of assuming one exists.
   */
  readonly isolation: "enforced" | "policy-only";
  execute(request: ContainedProcessRequest): Promise<ContainedProcessResult>;
  /**
   * Launches a long-lived contained process with streaming stdio (required for
   * interactive protocols such as ACP, where `execute` buffering to completion
   * is unusable). Backends without an interactive boundary omit this method;
   * callers must fail closed when it is absent.
   */
  spawn?(request: ContainedProcessRequest): ChildProcessWithoutNullStreams;
}
