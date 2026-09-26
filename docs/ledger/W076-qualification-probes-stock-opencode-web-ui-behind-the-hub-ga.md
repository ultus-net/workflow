<!-- Ledger fragment: extracted from TASKS.md at line 1331 of the PRE-freeze file (as of 52aa74d) on 2026-09-26. Live status lives in the GitHub Project; this file is a write-once landed record — append dated supersession notes, never rewrite. -->

### W076 - Qualification probes: stock opencode web UI behind the hub gateway; v2 config hot-reload

**Objective:** Turn the two remaining experimental seams into probe-gated, dated verdicts: (a) the
stock opencode web UI projected through the hub gateway as a second surface (per
`docs/ideas/hub-control-plane.md`); (b) v2 config hot-reload — a routing/settings change reaching a
live hub session without a restart.

**Depends on:** W075 (engine axis lands before probes exercise multiple agent kinds).

**Acceptance criteria:**
- [x] A live probe drives the stock opencode web UI behind the hub gateway and records the verdict
      per pinned version in `docs/HOST_ADAPTERS.md` (gated, skips clean when unset).
      (`test/opencode-webui-gateway-probe.test.ts`, gate `WORKFLOW_OPENCODE_WEBUI_PROBE=1`; **live
      green on stock v2.0.10, 2026-09-20** through the enforced gateway. Required a deliberate
      `app-shell` route class (§2.5 row) and surfaced the version-tolerance repair: v2.x serves the
      SPA on every bare path, so the health wait walks both contracts via the shared
      `src/integrations/opencode-health.ts` module (v1 JSON `{healthy:true}` or v2 `/api/info` —
      landed 2026-09-20 from a concurrent session in this checkout, folded into the W076 commit with
      attribution); the always-run runtime test (4/4) is repaired. The M1 attach probe's bare-path
      spellings are stale on v2.0.10 — stated in `docs/HOST_ADAPTERS.md` with the reason;
      re-qualification open.)
- [x] A live probe or deterministic test proves config publish → live session pickup (or documents
      the restart-required limitation honestly in `docs/FEATURES.md`). (Documented: launch-time
      application only — only `model` reaches a launch config today; reasoning effort has no launch
      consumer yet; no hot reload, changes reach a *new* session. Pinned by the routing UI copy +
      focused tests; `docs/FEATURES.md` row "Settings panel: model routing (slice 2)".)
- [x] No claim upgrades to Complete without the probe evidence; hub config publish remains the
      single journal of record. (The web-UI row was upgraded only with the live probe; W071's attach
      surface stays advisory/probe-PENDING with the staleness stated, not silently repaired.)

**Verification:** `WORKFLOW_OPENCODE_WEBUI_PROBE=1 node --import tsx --test
test/opencode-webui-gateway-probe.test.ts` green (v2.0.10, 2026-09-20); classifier + gateway suites
82/82; `test/opencode-server-runtime.test.ts` 4/4; typecheck and lint clean; dated rows in
`docs/HOST_ADAPTERS.md`, `docs/FEATURES.md`, and §2.5.

**Gap follow-ups (2026-09-20, same day — the two named gaps are closed):**
- **Fresh research** against the brand-new official v2 docs (`opencode.ai/v2/docs/api`, 136
  operations — §9): the matrix was reconciled with the documented inventory (bare permission/
  worktree/pty reads unblocked; documented session ops classified — `agent`/`model` switch,
  experimental `skill`/`wait`, staged-revert family, inbox PATCH; undocumented verbs like `PUT
  /api/session/{id}` and the speculative `switch` narrowed away), and the dual-lane integration
  decision (ACP = control lane; v2 HTTP API = data lane, per the operator) is recorded in project
  memory and §9.
- **M1 attach probe re-qualified live on v2.0.10** (`WORKFLOW_OPENCODE_SERVER_ATTACH=1`, v2
  spellings): config loaded and parsed, `/api/session` create through the gateway returns
  `data.id`, authority split holds, **broker SSE subscribes and intercepts without forwarding**
  (the engine's event stream now tries `/api/event` by content-type with a `/global/event`
  fallback). Still advisory — the live permission path needs a model key.
- **v2 provider-visibility finding** (§9, matching the upstream custom-provider issue class):
  config-defined providers do not list in `/api/provider` or `/api/model` on v2.0.10, and
  `/api/model/default` ignores the config `model`; the metered provider is asserted via the loaded
  config documents. Follow-up: evaluate the `/api/credential/{id}/activate` path for metered
  visibility.
- **The stock web UI tab is wired**: `openStockWebTab` (`src/cli/web-launch.ts`) surfaces the
  gateway-served stock UI as a second `workflow web` tab when the topology daemon is already
  running (probe-verified, quiet otherwise, foreign-host refused, `WORKFLOW_OPENCODE_STOCK_TAB=0`
  opt-out); 3/3 focused tests (`test/web-launch-tab.test.ts`).
