# Notify MCP

`notify-mcp` is the notification primitive the M7 care milestone needs: a
reminder is composed elsewhere and delivered through a **pluggable channel
seam**. There was no delivery primitive before this app — the toolbox
`notification` hits are MCP protocol notifications (server to client), not an
outgoing reminder.

## The channel seam (v1: seam only)

`src/channel.ts` defines the interface every channel implements:

```ts
interface NotificationChannel {
  readonly name: string;
  deliver(notification: NotificationRequest): Promise<DeliveryReceipt>;
}
```

`NotificationRequest` is `{ reminderId, recipient, body, urgency? }`. A
`DeliveryReceipt` carries `{ deliveryId, channel, delivered, deliveredAt }`, and
the `deliveryId` is the idempotency handle the Workflow-side delivery-id dedupe
store keys on for exactly-once (durability plan D5).

**v1 ships the seam plus one channel: `recording`.** The recording channel
captures the notification in memory and returns a receipt with a fresh
`deliveryId`; it performs **no external delivery**. This is deliberate. The
operator decision (Q4) was "ship the seam first, choose the channel later", so
the real channels — Discord, email, ntfy, SMS — are documented future
implementations of the same interface (see the comment block in
`src/channel.ts`) and are **not** implemented here. No network code exists in
this app.

The `notify` tool selects a channel by name. Only `recording` is registered;
an unknown name fails closed (`unknown notification channel`), so a
misconfigured care route is a loud error rather than a silently undelivered
reminder.

## The `notify` tool

| Field | Meaning |
| --- | --- |
| `reminderId` | The reminder's own id — the stable half of the dedupe key. |
| `recipient` | Where it goes. Free-form in v1; a real channel interprets it. |
| `body` | The text the care recipient reads. |
| `urgency` | `normal` or `high` (optional; a routing hint). |
| `channel` | Channel name; defaults to `recording`. |

It returns `{ deliveryId, delivered, channel }`. The app is **stateless**: it
holds no acknowledge/retry/escalate state — that state machine stays in the
stateless worker (Q73) — and persists nothing. Exactly-once is enforced
Workflow-side by `src/integrations/notify-delivery.ts`, so this process can be
restarted freely.

## Deferred (the next M7 care-route slice)

- The real channel implementation (Discord/email/ntfy/SMS) behind this seam.
- The acknowledge/retry/escalate state machine in the stateless worker (Q73).
- Wiring the care route's reminder jobs to this tool through the assistant MCP
  dispatch seam (`WORKFLOW_ASSISTANT_MCP_TOOLS` + `WORKFLOW_ASSISTANT_TOOL_CAPABILITIES`).

Requires Node.js 22 or newer. Run `pnpm run verify` to typecheck, build, and
test.
