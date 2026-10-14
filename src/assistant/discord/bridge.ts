/**
 * Discord↔gateway bridge (pure, `discord.js`-free). This is the testable core:
 * it decides access, resolves identity, and calls the assistant gateway. The
 * `discord.js` adapter (`connector.ts`) is the only file that imports the
 * library.
 *
 * Identity is the Discord user snowflake, sent as the `x-workflow-user` header
 * so the gateway can bind it to a route (coding|tutor|care). The connector owns
 * NO model logic and NO tools.
 */
import { ASSISTANT_IDENTITY_HEADER } from "../../integrations/assistant-gateway.js";
import { isAllowed, type DiscordAllowlist } from "./allowlist.js";

/** A message as forwarded from the Discord surface (already normalized). */
export interface DiscordIncomingMessage {
  readonly channelId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly content: string;
}

/** Minimal gateway client the bridge depends on (injected for testing). */
export interface DiscordGatewayClient {
  /** POST an OpenAI-shaped chat request; return the assistant text. */
  complete(input: {
    readonly identity: string;
    readonly messages: readonly { role: "user"; content: string }[];
    readonly model?: string;
  }): Promise<string>;
}

/** A reply to render back to Discord: the bound identity and the text. */
export interface DiscordReply {
  readonly identity: string;
  readonly text: string;
}

/**
 * Build a gateway client that POSTs to `<gatewayUrl>/v1/chat/completions` with
 * the identity header and the front-door client credential. Throws a clear
 * Error on a non-2xx response or a malformed OpenAI shape.
 *
 * The front door enforces its client Basic credential BEFORE the assistant
 * lane, so the connector must present the ingress `username:password` here. The
 * metered placeholder the egress proxy expects is set downstream by
 * `handleAssistantRequest`, never by this client.
 */
export function createDiscordGatewayClient(options: {
  readonly gatewayUrl: string;
  /** Front-door client credential (`tuiUsername:tuiPassword`), base64-encoded. */
  readonly basicAuth: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}): DiscordGatewayClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.gatewayUrl.replace(/\/+$/, "");
  return {
    async complete(input) {
      const model = input.model ?? options.model;
      const body: Record<string, unknown> = {
        messages: input.messages,
        stream: false,
      };
      if (model !== undefined) body.model = model;
      const response = await fetchImpl(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${options.basicAuth}`,
          [ASSISTANT_IDENTITY_HEADER]: input.identity,
        },
        body: JSON.stringify(body),
      });
      const raw = (await response.json().catch(() => undefined)) as
        | { error?: { message?: string }; choices?: Array<{ message?: { content?: unknown } }> }
        | undefined;
      if (!response.ok) {
        const message = raw?.error?.message ?? response.statusText;
        throw new Error(`discord gateway ${response.status}: ${message}`);
      }
      const content = raw?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("discord gateway returned a malformed completion body (choices[0].message.content missing)");
      }
      return content;
    },
  };
}

/** Options for {@link handleIncoming}. */
export interface DiscordBridgeOptions {
  readonly allowlist: DiscordAllowlist;
  readonly gateway: DiscordGatewayClient;
  readonly defaultModel?: string;
}

/**
 * Resolve identity and call the gateway. Returns `undefined` when the author is
 * not allowed (and does NOT call the gateway); otherwise returns the reply with
 * `identity === authorId` and the gateway's text.
 */
export async function handleIncoming(
  options: DiscordBridgeOptions,
  message: DiscordIncomingMessage,
): Promise<DiscordReply | undefined> {
  if (!isAllowed(message.authorId, options.allowlist)) return undefined;
  const model = options.defaultModel;
  const text = await options.gateway.complete({
    identity: message.authorId,
    messages: [{ role: "user", content: message.content }],
    ...(model === undefined ? {} : { model }),
  });
  return { identity: message.authorId, text };
}
