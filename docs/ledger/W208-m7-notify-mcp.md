# W208: notify-mcp channel seam and exactly-once delivery (D5)

Date: 2026-10-16. Branch: `feat/m7-notify-mcp`. Base: `6dea4684` (`feat/w205-assistant-mcp-dispatch`, PR #575).

## Problem

The M7 care milestone needs a notification primitive for reminders, and there
was none. The `notification` hits in the toolbox are MCP protocol
notifications (server to client), not an outgoing reminder, and the only real
notification path was the operator browser, which is unfit for a care
recipient. The operator decision (Q4, `augur/docs/planning-questions.md`) was:
build a new `notify-mcp` toolbox app with a **pluggable channel seam**, and for
v1 ship the **seam only** with a recording/no-op channel. The real channel
(Discord/email/ntfy/SMS) is decided later and gates M7. The
acknowledge/retry/escalate state machine stays in the stateless worker (Q73).

Durability plan D5 (exactly-once side effect) lands with this seam
(`augur/docs/durability-plan.md` §5, §6 step 4): W199 shipped D1-D4 and
explicitly deferred D5 here (`docs/ledger/W199-durability-and-research-conductor.md`,
"D5 deferred").

## What shipped

### The `notify-mcp` toolbox app (the channel seam)

`mcp-toolbox/apps/notify-mcp/` — one tool, `notify`, modeled on the sibling
`continuity-checkpoint-mcp` (same `createLoggingServer` + `installToolStreaming`
scaffolding, same SIGINT/SIGTERM close pattern, same `package.json` scripts and
`bundleDependencies`).

- `src/channel.ts` is the seam. `interface NotificationChannel { name;
  deliver(notification): Promise<DeliveryReceipt> }`. `NotificationRequest` is
  `{ reminderId, recipient, body, urgency? }`; `DeliveryReceipt` carries
  `{ deliveryId, channel, delivered, deliveredAt }`.
- **v1 ships one channel: `RecordingChannel`.** It captures the notification in
  memory and returns a receipt with a fresh `deliveryId`. It performs **no
  external delivery**. Discord, email, ntfy, and SMS are documented future
  implementations of the same interface only (a comment block in
  `src/channel.ts`); **no network code exists in the app**.
- `notify` selects a channel by name. Only `recording` is registered; an
  unknown name fails closed (`unknown notification channel '<name>'`), so a
  misconfigured care route is a loud error, not a silently undelivered
  reminder.
- The app is **stateless**: no ack/retry/escalate state (that is Q73's worker
  state machine), no persistence. Exactly-once is enforced Workflow-side, so
  the server process can restart freely.

### D5 — the delivery-id dedupe store (exactly-once side effect)

`src/integrations/notify-delivery.ts` (`DurableDeliveryLedger`). A reminder is
keyed by its `reminderId` plus an input digest of the notification payload.

- No record for the id: invoke the sink (the channel call), record its receipt,
  return it.
- Record with a **matching** digest: return the recorded receipt **without**
  invoking the sink. This is the "second attempt across a crash" path.
- Record with a **different** digest: throw `DeliveryConflictError` (fail
  closed). Silently serving the stale receipt, or delivering both, would be a
  real double-send.

The discipline mirrors `step-journal.ts`: atomic temp+rename persistence, a
digest guard, a `fromJSON`/`load`/`save` triple, and a `record()` hydration
path. D5 needed its own store rather than the step journal because a care
reminder's identity is the *reminder*, not the run that composes it: a
scheduler may re-send after a reboot with no run in hand, and
`(runId, stepId, attempt)` cannot name that.

### Catalog and card

- `src/integrations/toolbox-catalog.ts` gains the `notify-mcp` entry (the
  `learning-mcp` shape, sorted position). `test/toolbox-catalog.test.ts`
  executes the manifest against the real `mcp-toolbox/apps` tree, so the entry
  is now corpus-pinned.
- `mcp-toolbox/packages/protocol-baseline/src/apps.ts` gains the app to the
  card/conformance/measure inventory; `cards:generate` wrote
  `.well-known/server-card.json` from the compiled `tools/list`; `cards:check`
  reports `current notify-mcp`.
- `mcp-toolbox/pnpm-lock.yaml` gained the `apps/notify-mcp` importer (a new
  workspace package must be in the lockfile for `pnpm install --frozen-lockfile`).

## Explicit deferral (the next M7 care-route slice)

The real channel (Discord/email/ntfy/SMS) and the acknowledge/retry/escalate
state machine are **not** in this slice. Q4's channel choice needs operator
input and gates M7; Q73 puts the state machine in the stateless worker. Wiring
the care route's reminder jobs to this tool over the assistant MCP dispatch
seam (`WORKFLOW_ASSISTANT_MCP_TOOLS` + `WORKFLOW_ASSISTANT_TOOL_CAPABILITIES`)
is likewise the next slice.

## Evidence

- **D5 acceptance check** (`test/notify-delivery.test.ts`, 7/7 green): a `notify`
  step whose sink is called twice across a simulated crash yields one delivered
  reminder; the recorded `deliveryId` is returned on the replay and the sink
  count stays 1. Same reminder id with a different payload throws (fail
  closed); distinct reminders each deliver; disk round-trip re-dedupes; absent
  file loads empty; corrupt file is rejected; hydration conflict fails closed.
  Registered in sorted `test/ci-suites.txt`.
- **notify-mcp app tests** (`pnpm --filter notify-mcp run verify`, 6/6 green):
  the recording channel records and returns a deterministic receipt; the
  default channel is recording; an unknown channel fails closed; the compiled
  stdio server serves `notify`, rejects an unknown channel as a tool error, and
  streams MCP log notifications.
- **Toolbox build/typecheck** (`CI=true pnpm --dir mcp-toolbox run build`,
  `run typecheck`): clean; `cards:check` reports `current notify-mcp`.
- **Toolbox protocol-baseline tests** 15/15 green after the two app-count pins
  (`conformance.test.ts:17`, `measure.test.ts:11`) moved from 14 to 15.
- **Root**: `npx tsc --noEmit` 0, `npm run lint` 0, `npm run build` clean;
  `test/toolbox-catalog.test.ts` + `test/skill-connectors.test.ts` +
  `test/ci-suites-manifest.test.ts` 16/16 green.

## Not in this slice

- Any real channel implementation and any network call.
- The care-route probe suite and the Q73 ack/retry/escalate state machine.
- Durable timers remain dormant (`cli/hub.ts` still does not pass
  `timers`/`resumeTimer`), unchanged by this slice.
