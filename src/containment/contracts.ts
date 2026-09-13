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
  execute(request: ContainedProcessRequest): Promise<ContainedProcessResult>;
}
