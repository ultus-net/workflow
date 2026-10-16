import { randomUUID } from "node:crypto";

/**
 * The pluggable notification-channel seam (M7 care milestone, Q4).
 *
 * A care reminder is *composed* somewhere (the scheduler, the stateless
 * worker's ack/retry/escalate state machine per Q73) and *delivered* here. The
 * two concerns are deliberately separate: v1 ships this seam plus a recording
 * channel only, and the operator's real channel choice (Discord, email, ntfy,
 * SMS) lands later as another `NotificationChannel` implementation behind the
 * same interface. Nothing in this module talks to a network, so the seam is
 * exercisable with no credentials, no egress, and no operator decision.
 *
 * The receipt is the contract the delivery-id dedupe store keys on: a channel
 * MUST return a stable `deliveryId` for one notification so a replay can be
 * recognised as a replay (see `src/integrations/notify-delivery.ts`). The
 * exactly-once discipline lives there, not here; this module is the side effect
 * the store guards.
 */

/** One reminder to deliver. The shape a care route composes. */
export interface NotificationRequest {
  /** The reminder's own id — the dedupe key's stable half. */
  readonly reminderId: string;
  /** Where it goes. Free-form in v1; a real channel interprets it. */
  readonly recipient: string;
  /** The text the care recipient reads. */
  readonly body: string;
  /** Optional routing hint a real channel may use; v1 records it verbatim. */
  readonly urgency?: "normal" | "high";
}

/**
 * What a channel returns. `delivered` is false only for a channel that
 * deliberately did not transmit (the recording channel always "delivers" to
 * its own record); `deliveryId` is the idempotency handle the dedupe store
 * persists and returns on a replay.
 */
export interface DeliveryReceipt {
  readonly deliveryId: string;
  /** The channel's own name, echoed so the receipt is self-describing. */
  readonly channel: string;
  readonly delivered: boolean;
  /** ISO instant of the delivery attempt. */
  readonly deliveredAt: string;
}

/**
 * The seam every channel implements. One method, no lifecycle: a channel is
 * pure configuration plus a `deliver` call, so a process crash cannot leave a
 * channel half-open (there is nothing to hold open).
 */
export interface NotificationChannel {
  readonly name: string;
  deliver(notification: NotificationRequest): Promise<DeliveryReceipt>;
}

export interface RecordingChannelOptions {
  /** Injected clock so tests are deterministic; defaults to `new Date()`. */
  readonly now?: () => Date;
  /** Injected id source so tests pin the delivery id; defaults to `randomUUID()`. */
  readonly newId?: () => string;
}

/**
 * The v1 default channel: it records every notification and delivers nothing
 * externally. This is the honest "seam only" shape the operator asked for —
 * the app is fully wired, the network side is empty until the channel decision
 * lands. `delivered: true` records that the channel accepted the notification;
 * it is NOT a claim that a human saw it (no channel exists to see it yet).
 */
export class RecordingChannel implements NotificationChannel {
  readonly name = "recording";
  readonly #records: NotificationRequest[] = [];
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(options: RecordingChannelOptions = {}) {
    this.#now = options.now ?? ((): Date => new Date());
    this.#newId = options.newId ?? ((): string => randomUUID());
  }

  async deliver(notification: NotificationRequest): Promise<DeliveryReceipt> {
    this.#records.push(notification);
    return {
      deliveryId: this.#newId(),
      channel: this.name,
      delivered: true,
      deliveredAt: this.#now().toISOString(),
    };
  }

  /** Every notification this channel accepted, in delivery order (audit/tests). */
  recorded(): readonly NotificationRequest[] {
    return [...this.#records];
  }
}

/* ---------------------------------------------------------------------------
 * Future channels (documented, deliberately NOT implemented in v1):
 *
 * - DiscordChannel  — POST a DM to an allowlisted snowflake via the M3b
 *                     connector's outbound path.
 * - EmailChannel    — SMTP (or a provider API) to the care recipient.
 * - NtfyChannel     — POST to an ntfy topic; the lightest self-hosted option.
 * - SmsChannel      — a provider API (Twilio and friends); highest cost, the
 *                     escalation tier if a future channel ladder needs one.
 *
 * Each becomes a `NotificationChannel` with no change to `deliver` callers.
 * The channel choice gates M7 and needs operator input
 * (`augur/docs/integration-plan.md` §F item 4), so none of them ship here.
 * ------------------------------------------------------------------------- */

const CHANNELS: readonly NotificationChannel[] = [];

/**
 * The v1 channel registry: recording only. A caller selects a channel by name;
 * an unknown name fails closed rather than silently recording, so a
 * misconfigured care route is a loud error, never an undelivered reminder.
 */
export function defaultChannel(): NotificationChannel {
  return new RecordingChannel();
}

/** Look up a channel by name in the v1 registry (recording only). */
export function channelByName(name: string): NotificationChannel {
  if (name === "recording") return new RecordingChannel();
  const known = ["recording", ...CHANNELS.map((channel) => channel.name)].join(", ");
  throw new TypeError("unknown notification channel '" + name + "'; v1 ships: " + known);
}
