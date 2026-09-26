<!-- Ledger fragment: extracted from TASKS.md at line 1608 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W082 - Auto-compaction over the v2 API (restore the plugin-era feature)

**Objective:** Restore context-window maintenance lost in the plugin→hub pivot. OpenCode v2 exposes
compaction over the documented API (`POST /api/session/{sessionID}/compact`; provider/model config
distinguishes `native` vs `summary` compaction) **and its runtime already compacts on context
overflow instead of retrying** — no plugin involved, per the operator's no-plugins constraint. The
design is hub-owned and deterministic — not a prompt-side loop: (a) classify `compact` in the
route-class matrix (currently deny by default; it is session maintenance that cannot advance
canonical state — reclassify deliberately with tests, not by drift), (b) an operator compaction
control in the custom web UI, (c) a hub-owned auto-trigger at a usage threshold (deterministic
gate, budget-guard compatible), (d) probe per pinned version. The v2 compaction
hook (`ctx.session.hook("compaction")`) is explicitly NOT used — no plugins.

**Depends on:** W076 (gateway verdicts); probe gating per `docs/HOST_ADAPTERS.md`.

**Acceptance criteria:**
- [x] Route-class decision recorded in §2.5 with tests: `compact` is now an explicitly classified
      forwarded session-input op (operator-controlled maintenance) — classifier row + gateway
      forward test + upstream stub updated; the §2.5 bullet records the dated reclassification
      (`fork`/`move`/`remove`/staged-revert remain denied).
- [x] Research note: what OpenCode v2 does natively per compaction type (`native` vs `summary`) and
      whether the ACP lane (`opencode acp`) auto-compacts without the HTTP route — **completed
      2026-09-20** as the dated §9 research note (pinned v2.0.10 binary strings + the v2 OpenAPI):
      `native` compaction is provider-local (replay cannot reconstruct it), `summary` is v2's own
      persisted checkpoint; auto-compaction is per-model runtime config (`compactIfNeeded`,
      `compactThreshold`, `compaction.auto`) that runs on the session stream — **not** the HTTP
      route — so the ACP lane auto-compacts exactly when the model's config enables it, and the
      operator regression is the overflow `400` ("start a new session or use /compact") when auto
      is unavailable. No plugin involved, per the no-plugins constraint.
- [x] The PWA surfaces context pressure and a compaction control (custom UI, per the
      surface-division decision); the hub-side auto-trigger is deterministic and budget-guard-aware.
      (**Manual control landed 2026-09-20**: the inspector Context section's "Compact…" affordance →
      `POST /api/sessions/compact` → the manager's agent-session record → the documented route
      through the enforced gateway; the honest copy states the documented steering semantics
      (queued, runs at the next step boundary) and failures surface the gateway's reason verbatim.
      **Auto-trigger decided and landed 2026-09-21, config-side** — the design decision (operator
      direction 2026-09-20): ownership is the **session runtime under hub-written config**, per the
      §9 research note that the ACP lane auto-compacts exactly when the model's compaction config
      enables it, so Workflow's deterministic lever is composing `compaction: { auto: true }` into
      the hub-written config rather than owning a poller. The **hub scheduler** is rejected as
      owner (cron is the wrong shape for a threshold trigger; the hub daemon has no per-session
      visibility), the **session manager** is rejected (its ACP `usage_update` view covers only
      live web-UI sessions, and — store finding below — it cannot reach those sessions through the
      gateway anyway), and the **topology daemon monitor** is recorded as the data-lane follow-up
      behind a per-session usage-read probe (per-session message tokens are documented in the v2
      message payloads). Implementation: settings `agents.<id>.autoCompact` (explicit boolean,
      default off, workspace-over-global, panel toggle for opencode) composes
      `compaction: { auto: true }` in `meteredOpencodeConfig` — consumed by the ACP subprocess
      composition AND the topology server config (the daemon resolves the same preference
      fail-soft). **Budget-guard-aware by construction**: a compaction turn is a normal metered
      model turn through the same loopback proxy the W045 interactive budget guard watches, the
      sticky refusal gate still bounds every later prompt, and no bypass lane is composed. Focused
      pins: `test/auto-compact-config.test.ts` (3). **Store finding recorded honestly:** the web
      session registry's agent-session ids live in the ACP subprocess's scratch-HOME store while
      the gateway fronts the topology server's own store, so the manual control's admit path is
      qualified at the route level (probe-created session) and its session-level reachability for
      web-UI ACP sessions is unprobed — the control surfaces the gateway's refusal verbatim when
      the store does not hold the session, never a fabricated success. **Data-lane backstop
      monitor landed 2026-09-21** (operator direction): the daemon-side monitor
      (`src/integrations/opencode-server-monitor.ts`) ticks deterministically against the
      documented `GET /api/session` entries (each carries the session's `tokens` — live-verified
      shape on v2.0.10) and fires the documented compact route when a session crosses the
      operator-set threshold `agents.opencode.autoCompactAtTokens` (positive integer, never
      invented — absent/malformed leaves the monitor off); hysteresis re-arms only when usage
      drops below the threshold, failures back off with a doubling cooldown and record the
      server's message verbatim (never a fabricated success), and a sticky session-budget
      violation vetoes every fire. Pins: `test/opencode-server-monitor.test.ts` (6); the probe's
      live monitor arm (read path against the real server, evaluated ≥ 1, zero fires for an empty
      session) ran green the same day.)
- [x] Live probe evidence per pinned version; no enforced claim without it. (**Done 2026-09-20:**
      `test/opencode-compact-probe.test.ts` gated `WORKFLOW_OPENCODE_COMPACT_PROBE=1` ran live
      green on stock v2.0.10 through the **enforced** gateway — unauthenticated compact `401`,
      session create via the documented route, and compact **admitted** as the documented
      `Session.Inbox.Compaction` inbox item (queued at the next step boundary); the verdict is
      recorded in `docs/HOST_ADAPTERS.md`.) (**Auto-trigger probe added and run live 2026-09-21:**
      `test/opencode-auto-compact-probe.test.ts`, gated `WORKFLOW_OPENCODE_AUTO_COMPACT_PROBE=1`,
      ran live green on stock v2.0.10 — the composed hub-written config carries
      `compaction: { auto: true }` beside the pinned ask ruleset and the real server's
      `/api/config` documents include that document with the compaction block parsed (the
      config-load arm IS the deterministic trigger delivery). The LIVE auto-compact turn arm — a
      real model turn overflowing context and compacting — stays **PENDING** (needs a real model
      key, operator environment); recorded in `docs/PROBE_VERDICTS.json`
      (`opencode-auto-compact-config-load`, dated 2026-09-21, with the pending arm named in the
      row). No plugin hook is composed anywhere in this slice; no `enforced` claim for the
      runtime's auto-compaction behavior. **Monitor arm added and run live the same day:** the
      probe's second live describe starts a probe session through the documented route and runs
      the monitor's deterministic tick against the real server — the usage read (session entries'
      `tokens`) is qualified live (evaluated ≥ 1, zero fires for an empty session, clean errors).
