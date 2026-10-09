<!-- Ledger fragment: opened 2026-10-09 as the C1 Azure control-plane deploy path, task 2b (launcher plane-awareness). TASKS.md is frozen (post-freeze work tracks in the GitHub Project); write-once — append dated supersession notes, never rewrite. -->

### C1 task 2b — launcher plane-awareness (2026-10-09)

**Source:** task 2b of `docs/ledger/control-plane-c1-deploy-plan.md` §4; the
decided posture is spec §10:230-246 ("Launcher plane-awareness (decided
2026-09-25, rides C1)"): the remote plane is `minReplicas=1` by standing
posture, but can still be unreachable (revision restart, manual scale-in,
network). The launcher probes gateway health before attaching and classifies
the state before acting.

#### What was built

- **`src/integrations/plane-wake.ts` (new):**
  - `classifyPlaneState` — the pure table. Reachability wins outright
    (`ready`, carrying the version when the probe reported one). Otherwise the
    `az` session gates the wake: no session is `no-az` (an honest dead end,
    never a doomed attempt). With a session, resource facts split `asleep`
    (ONLY a proven `minReplicas===0`, which outranks a stopped
    `runningStatus` a zero-replica app reports) from `broken` (resource
    missing, non-`Succeeded` provisioning, unhealthy replica, or a running app
    whose gateway is still unreachable).
  - `planeStateLine` — the honest one-line notice ("ready", "asleep … waking
    automatically", "broken … cannot be woken: <reason>", "no-az … log in to
    enable plane wake").
  - `ensurePlaneReady` — probe → classify → wake a proven-asleep plane → bounded
    health poll. Every path resolves to an outcome; a transport fault or a
    `wake` throw is reported (`broken`), never propagated. The `no-az` path
    performs NO polling, so a missing `az` can never hang the launcher.
  - `resolvePlaneWakeTarget` — fail-closed env resolution: BOTH
    `WORKFLOW_PLANE_ACA_RESOURCE_GROUP` and `WORKFLOW_PLANE_ACA_APP` or neither
    (a partial pair throws).
  - `createAzurePlaneWakeDeps` — the real `az` deps: `account show` (session
    gate), `containerapp show --query` (facts), `containerapp update
    --min-replicas 1` (the wake). Argument array, no shell; a non-zero `az` exit
    yields no facts, which the classifier reads as `broken`, never `asleep`.
  - `ensureExplicitPlaneReady` — the lane the launcher calls. Unconfigured wake
    still probes and reports honestly (never touches `az`); configured runs the
    full classify/wake/poll.
- **`src/cli/opencode-attach.ts` (changed):** the explicit-gateway C1 lane now
  runs `ensureExplicitPlaneReady` and fails closed with the honest state line
  for any non-ready verdict. Before this task the lane attached
  unconditionally to the exported URL, so an asleep/broken plane produced a
  stock-client connection failure with no classification and no wake. The
  usage text documents the plane + wake env vars.

#### The one-way rule (recorded)

The module names only env VARIABLE names
(`WORKFLOW_PLANE_ACA_RESOURCE_GROUP`, `WORKFLOW_PLANE_ACA_APP`) — never an
instance value. The instance supplies the values, exactly as it supplies
`WORKFLOW_OPENCODE_GATEWAY_URL`/`_PASSWORD` (task 2's explicit lane).

#### Verification (measured, this session)

- `node --import tsx --test test/plane-wake.test.ts` → 15/15.
- Wider focused set (`plane-wake` + `plane-supervisor` +
  `opencode-server-launcher` + `workflow-launcher` + `kernel-purity` +
  `text-hygiene`) → 64/64.
- `npm run typecheck` → exit 0. `npm run lint` → exit 0.
- Added to `package.json` `test:ci`; the curated set goes 52 to 53 suites
  (`docs/CI.md`).

#### Residuals (recorded, not claimed)

- **No live `az` verification.** The `az`-backed deps and the real
  `containerapp update` are pinned by construction (the wake call shape) and by
  the injected-dep tests, not executed against Azure here. The C1 live probe
  is task 3.1 (🛰, `WORKFLOW_AZURE_PLANE_PROBE=1`). No "the plane wakes in
  Azure" claim is made.
- **The wake PATCH is `--min-replicas 1`, not a full revision/ingress
  repair.** By design: `broken` states (revision error, ingress gone) are
  reported, not blindly re-driven (spec: "do not attempt a wake that cannot
  succeed").
- **`ensureExplicitPlaneReady`'s unconfigured branch returns `ready` for a
  healthy gateway (silently — no notice) and `broken` with a "wake is not
  configured" reason for an unreachable one.** There is no `asleep`/`no-az`
  split without a target, because no wake could ever run. This is the honest
  classification for that configuration, stated so it is not read as a missing
  case.
