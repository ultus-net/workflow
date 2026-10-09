/**
 * Types for images/worker/run.mjs — a hand-maintained declaration so the worker
 * entry stays plain-runnable (`node run.mjs`, Node builtins only) while the
 * image pin test imports it with full types. Keep in sync with the .mjs
 * exports. The message/envelope shapes mirror src/integrations/azure-jobs-schema.ts.
 */

export interface AzureJobRepoRef {
  readonly url: string;
  readonly ref: string;
}

export interface AzureJobMessage {
  readonly specVersion: 1;
  readonly taskId: string;
  readonly repo: AzureJobRepoRef;
  readonly gitPush: { readonly secretRef: string };
  readonly model: { readonly id: string; readonly secretRef: string };
  readonly task: {
    readonly message: string;
    readonly declaredEvidence: readonly string[];
    readonly budgetSeconds: number;
    readonly permissionPosture: "advisory";
  };
  readonly mcp: { readonly manifest: readonly string[]; readonly corpusFingerprint: string };
  readonly artifacts: { readonly evidenceContainer: string; readonly blobPrefix: string };
}

export interface AzureJobRefEnvelope {
  readonly specVersion: 1;
  readonly taskId: string;
  readonly bodyRef: { readonly container: string; readonly blob: string };
}

export interface CorpusFingerprint {
  readonly fingerprint: string;
  readonly fileCount: number;
}

export type WorkerConfig =
  | { readonly kind: "invalid"; readonly missing: readonly string[] }
  | {
      readonly kind: "configured";
      readonly queueUrl: string;
      readonly vaultName: string;
      readonly accountUrl: string;
      readonly visibilitySeconds: number;
      readonly modelEnvVar: string | undefined;
    };

export interface WorkerDeps {
  readonly fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly run?: (args: {
    cwd: string;
    prompt: string;
    modelId: string;
    modelEnv: Record<string, string>;
    budgetSeconds: number;
    opencodeBin?: string;
  }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readonly clone?: (args: { parent: string; url: string; ref: string; authEnv?: Record<string, string> }) => Promise<string>;
  readonly publish?: (args: {
    checkout: string;
    taskId: string;
    baseRef: string;
    repoUrl: string;
    gitToken: string;
    title?: string;
    fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  }) => Promise<{ branch: string; prUrl?: string }>;
  readonly now?: () => string;
  readonly log?: (line: string) => void;
  readonly corpusRoot?: string;
  readonly fingerprintFile?: string;
}

export function validateAzureJobMessage(value: unknown): AzureJobMessage;
export function isRefEnvelope(value: unknown): boolean;
export function validateRefEnvelope(value: unknown): AzureJobRefEnvelope;
export function fingerprintCorpus(appsRoot: string): CorpusFingerprint;
export function readRecordedFingerprint(path: string): string;
export function verifyCorpus(corpusAppsRoot: string, declared: string, fingerprintFile?: string): CorpusFingerprint;
export function getAccessToken(scope: string, fetcher?: (url: string, init?: RequestInit) => Promise<Response>): Promise<string>;
export function dequeue(
  queueUrl: string,
  token: string,
  visibilitySeconds: number,
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<{ raw: string; messageId: string; popReceipt: string } | undefined>;
export function renewMessage(
  queueUrl: string,
  token: string,
  messageId: string,
  popReceipt: string,
  visibilitySeconds: number,
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string>;
export function deleteMessage(
  queueUrl: string,
  token: string,
  messageId: string,
  popReceipt: string,
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<void>;
export function readBlob(
  accountUrl: string,
  container: string,
  blobPath: string,
  token: string,
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string>;
export function putBlob(
  accountUrl: string,
  container: string,
  blobPath: string,
  body: string,
  token: string,
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<void>;
export function readKeyVaultSecret(
  vaultName: string,
  secretRef: string,
  token: string,
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<string>;
export function runOpencode(args: {
  cwd: string;
  prompt: string;
  modelId: string;
  modelEnv: Record<string, string>;
  budgetSeconds: number;
  opencodeBin?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }>;
export function cloneCheckout(args: {
  parent: string;
  url: string;
  ref: string;
  authEnv?: Record<string, string>;
}): Promise<string>;
export function gitAuthEnv(repoUrl: string, token: string): Record<string, string>;
export function parseGithubRepo(url: string): { owner: string; repo: string; apiBase: string } | undefined;
export function publishResult(args: {
  checkout: string;
  taskId: string;
  baseRef: string;
  repoUrl: string;
  gitToken: string;
  title?: string;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ branch: string; prUrl?: string }>;
export function redactSecret(error: unknown, secret: string): string;
export function workerConfigFromEnv(env?: Record<string, string | undefined>): WorkerConfig;
export function runWorkerTurn(args: {
  message: AzureJobMessage;
  config: Extract<WorkerConfig, { kind: "configured" }>;
  deps?: WorkerDeps;
}): Promise<{ blob: string; corpusFingerprint: string }>;
export function main(env?: Record<string, string | undefined>, deps?: WorkerDeps): Promise<void>;
