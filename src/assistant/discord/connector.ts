/**
 * Discord surface adapter — the ONLY `discord.js` consumer in the assistant
 * subtree. Everything else (allowlist, chunking, debouncer, draft-stream,
 * bridge) is pure and tested with fakes, so the library stays confined to this
 * one file and the isolation gate (discord.js imported only here) holds.
 *
 * The connector forwards a user's message to the assistant gateway and renders
 * the reply. It is outbound-only: no model logic, no tools.
 */
import { Client, Events, GatewayIntentBits, type Message } from "discord.js";

import { Debouncer } from "./debouncer.js";
import { chunkMessage } from "./messaging.js";
import { createDiscordGatewayClient, handleIncoming, type DiscordIncomingMessage } from "./bridge.js";
import { isAllowed, type DiscordAllowlist } from "./allowlist.js";

/** The injectable Discord surface. The real one wraps a `discord.js` `Client`. */
export interface DiscordSurface {
  /** Register a handler for each inbound message. */
  onMessage(handler: (m: DiscordIncomingMessage) => void): void;
  /** Send `text` to a channel. */
  send(channelId: string, text: string): Promise<void>;
  /** Edit an existing message. */
  edit(channelId: string, messageId: string, text: string): Promise<void>;
  /** Connect and log in with the bot token. */
  start(token: string): Promise<void>;
  /** Disconnect the client. */
  stop(): Promise<void>;
}

/**
 * Create the real Discord surface over a `discord.js` `Client` with the Guilds,
 * GuildMessages, and MessageContent intents. Message Content is a privileged
 * intent and must be enabled in the Discord app settings.
 */
export function createDiscordSurface(): DiscordSurface {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  async function fetchChannel(channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (channel === null || !channel.isSendable()) {
      throw new Error(`discord channel ${channelId} is not a sendable text channel`);
    }
    return channel;
  }

  return {
    onMessage(handler) {
      client.on(Events.MessageCreate, (message: Message) => {
        // Ignore bot messages (including our own) so the connector cannot loop.
        if (message.author.bot) return;
        handler({
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          content: message.content,
        });
      });
    },
    async send(channelId, text) {
      const channel = await fetchChannel(channelId);
      await channel.send(text);
    },
    async edit(channelId, messageId, text) {
      const channel = await fetchChannel(channelId);
      const message = await channel.messages.fetch(messageId);
      await message.edit(text);
    },
    async start(token) {
      await client.login(token);
    },
    async stop() {
      await client.destroy();
    },
  };
}

/** Configuration for {@link startDiscordConnector}. */
export interface DiscordConnectorConfig {
  readonly token: string;
  readonly gatewayUrl: string;
  /** Front-door client credential (`tuiUsername:tuiPassword`), base64-encoded. */
  readonly basicAuth: string;
  readonly allowlist: DiscordAllowlist;
  readonly model?: string;
}

/**
 * Wire the surface to the bridge: each allowed inbound message is debounced per
 * channel, sent to the gateway, chunked, and sent back. Returns a handle whose
 * `stop()` tears the surface down.
 */
export async function startDiscordConnector(
  config: DiscordConnectorConfig,
  surface: DiscordSurface = createDiscordSurface(),
): Promise<{ stop(): Promise<void> }> {
  const gateway = createDiscordGatewayClient({
    gatewayUrl: config.gatewayUrl,
    basicAuth: config.basicAuth,
    ...(config.model === undefined ? {} : { model: config.model }),
  });
  const debouncer = new Debouncer({ delayMs: 750 });

  surface.onMessage((message) => {
    if (!isAllowed(message.authorId, config.allowlist)) return;
    debouncer.schedule(message.channelId, async () => {
      const reply = await handleIncoming(
        { allowlist: config.allowlist, gateway, ...(config.model === undefined ? {} : { defaultModel: config.model }) },
        message,
      );
      if (reply === undefined) return;
      const chunks = chunkMessage(reply.text);
      for (const chunk of chunks) await surface.send(message.channelId, chunk);
    });
  });

  await surface.start(config.token);

  return {
    async stop() {
      debouncer.cancelAll();
      await surface.stop();
    },
  };
}
