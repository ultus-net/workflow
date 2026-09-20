# W079 — Hash-anchored edits vs the read-fingerprint ledger: evaluation and decision

**Date:** 2026-09-20 · **Status:** decision recorded — **REJECT** (keep the digest/size/mtime
ledger; one scoped follow-up noted) · **Evidence base:** as-built code + the DRIFT-022 register
row. Idea adopted from oh-my-openagent / "The Harness Problem" (`LINE#ID` content-hash tags on
reads, edits validated against the tags); **pattern evaluation only — no upstream code was read,
ported, or run.** Per the W079 box, no code accompanies this decision.

## 1. The as-built mechanism (what would be replaced)

The current freshness model is **whole-file content identity, re-verified at the authorization
boundary** (DRIFT-022 partial port — commits `b55c7d0`, `0c0da3d`, `85bd1c8`):

- **Capture point 1 — the ACP client-delegated fs lane.** `AcpSessionDriver` answers
  `fs/read_text_file` and records `fingerprintFile(path)` — sha256 of the full file bytes, size,
  `mtimeMs` (`src/integrations/acp-session.ts` → `src/application/file-claim-ledger.ts`). The
  fingerprint is captured at the moment Workflow itself served the read, so the ledger never
  trusts an agent-reported read.
- **Capture point 2 — the v2 gateway lane.** `OpenCodeV2SessionClaims.recordRead` records the
  same fingerprint shape per session and path (`src/integrations/opencode-v2-session-claims.ts`),
  with parent/child session identity and a mutation budget beside it.
- **Enforcement point — the authorization seam, never prompt text.** `WorkflowApplication.authorize`
  denies a mutating action whose subject path lacks a recorded fingerprint or whose recorded
  fingerprint no longer matches the current file (`matchesCurrent`: re-stat + re-hash) with
  `STALE_OR_MISSING_READ` — fail-closed (`src/application/workflow.ts`; the host gate is the
  explicit `requireReadFingerprint` flag so advisory hosts cannot drift into claiming it).
- **Claims are exclusive per file** (`claim`/`release`), so a second session cannot interleave a
  mutation on a path another session has claimed.

Properties that matter for the comparison: the digest is computed over the **whole file** at read
time; freshness is re-checked by re-hashing at authorize time (mtime/size are corroborating
signals, not the truth — a same-size, same-mtime, different-content write still fails on digest);
and any external change to any byte stales **every** pending claim on that file.

## 2. The proposal under evaluation (hashline)

Hashline-style read surfaces tag each line with a content-hash identity (`LINE#id`), and edit
requests address lines by tag; the enforcement point validates the referenced tags against the
current content before the edit applies. The claimed wins are (a) **line-granular staleness** —
an unrelated change elsewhere in the file does not stale an edit to an unaffected line, and
(b) **anchoring** — "edit line N" survives renumbering because identity is content-derived.

## 3. Adversarial analysis

| Case | Current ledger (digest/size/mtime) | Hashline (per-line content hash) |
| --- | --- | --- |
| Same-hash collisions | sha256 over the whole file — no practical collision surface | Trivially common: every blank line, every repeated import, every identical statement hashes alike. Disambiguating requires a positional component in the tag, and a positional+hash tag is invalidated by insertions ABOVE the anchor — the anchoring win evaporates exactly where agents work (top-of-file edits, import churn) |
| Truncated reads | The ACP lane reads whole files (`readFile`), so the fingerprint always covers the full content; a truncated read therefore still gates the write on whole-file freshness — fail-closed over unseen bytes | Tags only cover lines actually surfaced; enforcement must decide what a write beyond the read window means — hashline alone does not answer it, so an extra rule ("unseen region ⇒ stale") is REQUIRED, i.e. hashline degrades to the whole-file rule everywhere it matters |
| Stale edits after external change | Detected at authorize time by re-hash (any change anywhere stales) — strict, no interpretation | Detected by hash mismatch on the referenced lines — detects the SAME hazard, but is willing to proceed past changes the agent did not reference |
| Agent-fabricated tags | Fingerprints originate exclusively from Workflow's own read capture (driver/gateway), never from agent-supplied values | Same requirement applies — tags must originate at the capture point; the enforcement story is identical, so hashline adds no trust property |
| Concurrent sessions | Exclusive per-path claims, second claimant refused | Per-line claims reintroduce the ambiguity the exclusivity exists to remove (two sessions editing different lines of one file with no coordination) |
| Cost | One fingerprint per read; O(file) hash at read and at authorize | Per-line tags on every read (token budget on every read surface), a second claim ledger keyed by line, and a tag-validation enforcement path — all to be maintained per host version |

## 4. Enforcement-point comparison (the part that matters most)

Both schemes enforce at the same place — `WorkflowApplication.authorize` (and the gateway's claim
validation), never in prompt text. What changes is only the identity granularity. The decisive
honest-claims observation: **on every surface where Workflow owns the edit path today, the current
ledger is already enforced and probe-pinned; hashline would not move the enforcement point one
inch — it would only relax what counts as stale.** And the relaxation is exactly the cross-edit
staleness hazard the ledger exists to catch: a file the agent is about to mutate DID change
somewhere; "only the lines I reference" is the agent's claim, and the ledger's job is to distrust
exactly that kind of claim. A surface where hashline enforcement would be genuinely NEW (OpenCode's
native edit tool running inside the contained agent, bypassing both capture points) is a surface
Workflow does not own — adding hashline there would be prompt-coupled enforcement, which the W079
box explicitly rules out ("edit validation through the guard, not prompt text").

## 5. Decision: **REJECT** (evidence recorded above)

- The current digest/size/mtime ledger is strictly more conservative on every adversarial case the
  evaluation surfaced (collisions, unseen-region writes, fabricated identity), is already
  implemented, test-pinned, and probe-wired, and carries zero per-read token cost.
- Hashline's single honest win — line-granular non-staleness — is a convenience that weakens the
  fresh-read-before-mutation invariant (DRIFT-022, W072 I-invariants) in exactly the
  concurrent-edit hazard domain it claims to improve.
- Full adopt would also cost a per-host capture rework (read surfaces must emit tags) and a probe
  family per pinned version for a mechanism that buys no new enforcement.

## 6. The one real improvement hashline surfaced (recorded as a scoped option, NOT adopted)

A **truncated/partial read** on a lane where reads can carry a window (offset/limit — the ACP
protocol supports it; today's ACP driver ignores it and reads whole files) currently claims
whole-file freshness for content the agent never saw. The small, local fix — recording the read
window beside the fingerprint and letting `STALE_OR_MISSING_READ` treat out-of-window subjects as
stale — is **not adopted here**; it needs its own dated decision if and when the gateway lane
actually surfaces windowed reads (the ACP lane does not today). Until then the fail-closed
whole-file freshness stands, and no code changes with this decision (per the W079 box).

## 7. Probe plan (moot under REJECT; recorded for completeness)

Had adoption been decided, the evidence per pinned host version would have been: (1) a capture
probe — every read surface emits stable line tags (same file, two reads, byte-equal tags); (2) an
enforcement probe — a stale-tag edit is denied at the guard with a usable reason and a fresh-tag
edit is admitted; (3) adversarial probes — identical-line collisions with positional anchors under
insertions, a truncated read followed by a write beyond the window, and a fabricated-tag edit.
Each would have landed as an env-gated probe file with its verdict in `docs/HOST_ADAPTERS.md` and
the register (`docs/PROBE_VERDICTS.json`). Under REJECT these are not run and no behavior is
claimed.

## 8. Evidence trail

- As-built capture/enforcement: `src/application/file-claim-ledger.ts`,
  `src/application/workflow.ts` (`STALE_OR_MISSING_READ`), `src/application/host.ts`
  (`requireReadFingerprint`), `src/integrations/acp-session.ts` (ACP fs-read capture),
  `src/integrations/opencode-v2-session-claims.ts` (gateway lane).
- DRIFT-022 register rows: `docs/COMPLIANCE_REGISTER.md` (2026-09-19 partial-port entry —
  commits `b55c7d0`, `0c0da3d`, `85bd1c8`; `test/file-claim-ledger.test.ts`).
- Host-version claim discipline: `docs/HOST_ADAPTERS.md` (probe rules, fail closed).
- Idea provenance: oh-my-openagent / "The Harness Problem" — pattern only, SUL-1.0 upstream, no
  code read or ported.