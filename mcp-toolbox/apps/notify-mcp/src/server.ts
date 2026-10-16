#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createLoggingServer, installToolStreaming } from "@agent-tools/mcp-server-kit";

import { channelByName } from "./channel.js";

/**
 * notify-mcp — the care-reminder delivery seam (M7, Q4).
 *
 * One tool, `notify`, hands a reminder to a `NotificationChannel` (see
 * `channel.ts`). v1 ships the seam plus its recording channel only; the
 * operator's real channel choice lands later behind the same interface. The
 * app is stateless: it holds no ack/retry/escalate state (that state machine
 * stays in the stateless worker per Q73) and persists nothing. Exactly-once is
 * the `src/integrations/notify-delivery.ts` store's job, not the server's, so
 * this process can be restarted freely.
 */

const server = createLoggingServer(
  { name: "notify-mcp", version: "0.1.0" },
);

installToolStreaming(server, { logger: "notify-mcp" });

server.registerTool("notify", {
  description: "Deliver a care reminder through a notification channel. v1 ships a recording channel that captures the reminder without external delivery; the real channel (Discord/email/ntfy/SMS) is a later M7 decision behind the same channel seam. Returns the delivery receipt (deliveryId, delivered, channel) that the delivery-id dedupe store keys on for exactly-once.",
  inputSchema: {
    reminderId: z.string().min(1).max(200),
    recipient: z.string().min(1).max(500),
    body: z.string().min(1).max(4_000),
    urgency: z.enum(["normal", "high"]).optional(),
    channel: z.string().min(1).max(100).default("recording"),
  },
  outputSchema: {
    deliveryId: z.string(),
    delivered: z.boolean(),
    channel: z.string(),
  },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
}, async (input) => {
  const channel = channelByName(input.channel);
  const receipt = await channel.deliver({
    reminderId: input.reminderId,
    recipient: input.recipient,
    body: input.body,
    ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
  });
  const structuredContent = {
    deliveryId: receipt.deliveryId,
    delivered: receipt.delivered,
    channel: receipt.channel,
  };
  return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
});

process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
await server.connect(new StdioServerTransport());
