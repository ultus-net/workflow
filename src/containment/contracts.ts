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
  readonly enforcement: "enforced";
  readonly network: "isolated" | "host";
  readonly credentials: "cleared" | "explicit";
}

export interface ProcessContainment {
  execute(request: ContainedProcessRequest): Promise<ContainedProcessResult>;
}
