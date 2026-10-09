/**
 * The Azure Storage Queue dispatch client (C1 deploy plan §2.c, decision D3).
 *
 * The hub is the dispatch owner: it validates a task-spec message structurally,
 * then enqueues it to the `workflow-dispatch` queue. A worker pod pulls one
 * message = one job execution. Oversized messages ride a blob ref in the same
 * storage account.
 *
 * Protocol: REST only, no Azure SDK — the key-vault.ts discipline (W156). Auth
 * is the shared IMDS/azure-cli Bearer chain (`azure-token.ts`); Queue REST with
 * Entra ID needs only `x-ms-date` + `Authorization: Bearer` + `x-ms-version`,
 * no SharedKey signature. Every request is bounded with `AbortSignal.timeout`.
 *
 * Fail-closed posture: the capability is opt-in (`WORKFLOW_AZURE_JOBS=1`) and
 * requires `WORKFLOW_AZURE_QUEUE_URL` + `WORKFLOW_AZURE_EVIDENCE_CONTAINER`. A
 * missing or malformed declaration is named and refused at config load — never
 * best-effort.
 */

import {
  AzureJobMessageError,
  serializeAzureJobMessage,
  validateAzureJobMessage,
  type AzureJobMessage,
} from "./azure-jobs-schema.js";
import { createCachedTokenSource, defaultAzureTokenFetcher, type AccessTokenFetcher } from "./azure-token.js";

/** The Azure Storage data-plane resource for Entra ID auth. */
export const AZURE_STORAGE_SCOPE = "https://storage.azure.com/";
/** A storage service version that accepts Entra ID Bearer auth (2017-11-09+). */
export const AZURE_STORAGE_API_VERSION = "2023-11-03";
/**
 * Azure's Put Message body limit is 64 KiB measured on the WIRE — i.e. after
 * the message is base64-encoded into `MessageText`. Base64 expands 4/3, so the
 * inline JSON ceiling is 48 KiB; anything larger must ride the blob-ref. Using
 * the raw payload size against a 64 KiB constant would under-count and send an
 * over-limit body (Azure answers 413).
 */
export const QUEUE_BODY_LIMIT_BYTES = 48 * 1024 - 256;

export type AzureJobsDispatchState =
  | { readonly kind: "unconfigured"; readonly missing: readonly string[] }
  | {
      readonly kind: "configured";
      readonly queueUrl: string;
      readonly accountUrl: string;
      readonly evidenceContainer: string;
    };

/** The enqueue-result shape the hub route and the hub bridge share (one name, no drift). */
export interface AzureJobDispatchResult {
  readonly taskId: string;
  readonly messageId: string;
  readonly viaBlobRef: boolean;
}

/** The composed capability the hub route calls (validates + enqueues). */
export type AzureJobDispatchFn = (message: unknown) => Promise<AzureJobDispatchResult>;

export type AzureJobsHttpFetcher = (url: string, init?: RequestInit) => Promise<Response>;

// A queue URL is https://<account>.queue.core.windows.net/<queue> (no trailing
// slash); a "/" in the queue segment would forge an extra API path segment.
const QUEUE_URL = /^https:\/\/([a-z0-9]{3,24})\.queue\.core\.windows\.net\/([A-Za-z0-9-]{3,63})$/;

/**
 * Classifies the dispatch declaration from env, mirroring the board-provider
 * lanes: absent variables are listed under their NAMES; a malformed queue URL
 * is named invalid rather than silently coerced. `WORKFLOW_AZURE_JOBS` absent
 * or not `1` is the unconfigured state (the capability is opt-in).
 */
export function azureJobsDispatchFromEnv(env: NodeJS.ProcessEnv): AzureJobsDispatchState {
  const missing: string[] = [];
  const enabled = (env.WORKFLOW_AZURE_JOBS ?? "").trim();
  if (enabled !== "1") {
    // Not opted in: the capability is withheld. Name the enabling variable so
    // the refusal is legible, but this is the ordinary off state.
    return { kind: "unconfigured", missing: ["WORKFLOW_AZURE_JOBS"] };
  }
  const queueUrl = (env.WORKFLOW_AZURE_QUEUE_URL ?? "").trim();
  if (queueUrl.length === 0) missing.push("WORKFLOW_AZURE_QUEUE_URL");
  const evidenceContainer = (env.WORKFLOW_AZURE_EVIDENCE_CONTAINER ?? "").trim();
  if (evidenceContainer.length === 0) missing.push("WORKFLOW_AZURE_EVIDENCE_CONTAINER");

  const match = QUEUE_URL.exec(queueUrl);
  if (queueUrl.length > 0 && match === null) {
    missing.push("WORKFLOW_AZURE_QUEUE_URL (invalid — expected https://<account>.queue.core.windows.net/<queue>)");
  }
  if (evidenceContainer.length > 0 && !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(evidenceContainer)) {
    missing.push("WORKFLOW_AZURE_EVIDENCE_CONTAINER (invalid — lowercase alphanumeric/dash, 3-63 chars)");
  }
  if (missing.length > 0 || match === null) return { kind: "unconfigured", missing };
  return {
    kind: "configured",
    queueUrl,
    accountUrl: `https://${match[1]}.blob.core.windows.net`,
    evidenceContainer,
  };
}

export interface AzureJobsDispatch {
  /**
   * Validates and enqueues one dispatch message. Returns the queue's message
   * id plus the effective task id. Throws on any validation
   * (`AzureJobMessageError`) or transport failure — never a silent drop.
   */
  enqueue(message: unknown): Promise<AzureJobDispatchResult>;
}

/**
 * Builds the dispatch client. `queueUrl`/`accountUrl`/`evidenceContainer` come
 * from `azureJobsDispatchFromEnv`; `fetcher` and `getToken` are injectable for
 * hermetic tests (the key-vault pattern).
 */
export function createAzureJobsDispatch(options: {
  queueUrl: string;
  accountUrl: string;
  evidenceContainer: string;
  fetcher?: AzureJobsHttpFetcher;
  getToken?: AccessTokenFetcher;
  timeoutMs?: number;
}): AzureJobsDispatch {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const token = createCachedTokenSource(AZURE_STORAGE_SCOPE, options.getToken ?? defaultAzureTokenFetcher(process.env, fetcher));

  async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await token()}`,
      "x-ms-version": AZURE_STORAGE_API_VERSION,
      "x-ms-date": new Date().toUTCString(),
      ...extra,
    };
  }

  async function putBlob(container: string, blobPath: string, body: string): Promise<void> {
    // Encode each path segment: the schema already restricts taskId/blobPrefix
    // to a safe charset, and encoding is defense in depth against a future
    // loosening (the key-vault.ts discipline).
    const path = blobPath.split("/").map(encodeURIComponent).join("/");
    const url = `${options.accountUrl}/${encodeURIComponent(container)}/${path}`;
    const response = await fetcher(url, {
      method: "PUT",
      headers: await authHeaders({ "x-ms-blob-type": "BlockBlob", "Content-Type": "application/json" }),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`azure job dispatch: blob upload answered ${response.status}`);
    }
  }

  async function enqueue(message: unknown): Promise<{ taskId: string; messageId: string; viaBlobRef: boolean }> {
    const validated: AzureJobMessage = validateAzureJobMessage(message);
    // The configured evidence container is authoritative: a message must not
    // redirect the write to a different container (a hostile message cannot
    // choose its destination). A declared container that disagrees is refused.
    if (validated.artifacts.evidenceContainer !== options.evidenceContainer) {
      throw new AzureJobMessageError(
        `invalid azure job message: artifacts.evidenceContainer '${validated.artifacts.evidenceContainer}' ` +
          `does not match the configured WORKFLOW_AZURE_EVIDENCE_CONTAINER`,
      );
    }
    const json = serializeAzureJobMessage(validated);
    let payloadJson = json;
    let viaBlobRef = false;
    if (Buffer.byteLength(json, "utf8") > QUEUE_BODY_LIMIT_BYTES) {
      // Honor the declared artifacts layout: <blobPrefix>/<taskId>.json.
      const blob = `${validated.artifacts.blobPrefix}/${validated.taskId}.json`;
      await putBlob(options.evidenceContainer, blob, json);
      payloadJson = JSON.stringify({
        specVersion: validated.specVersion,
        taskId: validated.taskId,
        bodyRef: { container: options.evidenceContainer, blob },
      });
      viaBlobRef = true;
    }
    // The queue body is XML: <QueueMessage><MessageText>base64(json)</MessageText>.
    const encoded = Buffer.from(payloadJson, "utf8").toString("base64");
    const xml = `<?xml version="1.0" encoding="utf-8"?><QueueMessage><MessageText>${encoded}</MessageText></QueueMessage>`;
    const response = await fetcher(`${options.queueUrl}/messages`, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/xml" }),
      body: xml,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`azure job dispatch: the queue answered ${response.status}`);
    }
    const text = await response.text();
    const messageId = /<MessageId>([^<]+)<\/MessageId>/.exec(text)?.[1];
    if (messageId === undefined) {
      throw new Error("azure job dispatch: the queue response carried no MessageId");
    }
    return { taskId: validated.taskId, messageId, viaBlobRef };
  }

  return { enqueue };
}
