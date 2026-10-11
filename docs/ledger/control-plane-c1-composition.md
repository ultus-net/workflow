<!-- Ledger fragment: opened 2026-10-09 as the control-plane image C1 composition + first-build record (W149 deploy path). TASKS.md is frozen (post-freeze work tracks in the GitHub Project); write-once — append dated supersession notes, never rewrite. -->

### Control-plane image: first real build, defects fixed, and the C1 composition decision (2026-10-09)

**Source:** the open-side half of the deployment-instance split
(`docs/superpowers/specs/2026-09-26-deployment-instance-split.md` §5/§10 Q2)
and the C1 milestone (`docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`
§8/§10). The prior record (`docs/ledger/w149-publish-digest.md`) left the
image **unbuilt**: "the Dockerfile is unverified until a build" (line 92).
This entry closes that gap with a real build and reports the defects it
surfaced.

#### What was done

The image was built locally with **podman** (docker is absent on this host):

    podman build -f images/control-plane/Dockerfile -t workflow-cp:test .

The qualified stock opencode binary was staged from `~/.local/bin/opencode`
(sha256 `c2fe3b18be9e67222d136c818512e3a07213d86ffd5d9176919965d08ac9b9db`,
matching the committed `images/control-plane/opencode.sha256`) — the same
bytes the publish workflow will download from the tagged release asset.

Build iterations surfaced **six defects**; all are fixed here. None was
inferable from reading alone — each was measured. A **seventh** (the
unguarded `.gitignore`) was found on review of the staged tree and is fixed
below too.

#### Defect 1 — `COPY src tsconfig.json ./` flattened `src` (build-breaking)

`COPY src tsconfig.json tsconfig.build.json ./` copies the **contents** of
the `src` directory (Docker multi-source COPY semantics: a source that is a
directory contributes its contents when the destination is a directory), so
`/app/src` never existed. `tsc -p tsconfig.build.json` then failed:

    error TS18003: No inputs were found in config file '/app/tsconfig.build.json'.

Fixed to explicit destinations (`COPY tsconfig.json tsconfig.build.json ./`,
`COPY src ./src`, `COPY scripts ./scripts`) at
`images/control-plane/Dockerfile`. Pinned by
`test/control-plane-dockerfile.test.ts`.

#### Defect 2 — opencode aborting on a `/tmp/opencode` file collision (build-breaking)

The binary was staged at `/tmp/opencode`; opencode uses `$TMPDIR/opencode`
as its own runtime directory and aborted:

    ERROR: Error: EEXIST: file already exists, mkdir '/tmp/opencode'

so `opencode --version` failed and the version-drift gate failed the build.
Fixed: the binary lands at its final `/usr/local/bin/opencode`, the pin file
stages at `/opt/opencode.sha256` (a path opencode never creates), and the
verify runs from `/usr/local/bin`. Pinned.

#### Defect 3 — the toolbox build aborted under no TTY (guard server missing)

`run: ... node scripts/prepare-tool.mjs` runs `pnpm --dir mcp-toolbox run
build`, which reconciles the workspace `node_modules`. With no TTY pnpm
aborted the purge:

    ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY

`prepare-tool.mjs` swallows the failure ("prepare: toolbox skipped"), so the
build **succeeded while shipping no `workflow-guard-mcp/dist/server.js`** —
a silently guardless control plane. Fixed: `CI=true` on the pnpm/`npm run
build`/`prepare-tool`/`npm ci` steps (pnpm's documented non-interactive
signal). Verified: the rebuilt image logs `prepare: toolbox ok` and
`apps/workflow-guard-mcp build: Done`. Pinned.

#### Defect 4 — the CMD bin did not resolve (runtime-breaking)

`npm ci` installs dependencies but **never links the root package's own
`bin` entries**, so `CMD ["workflow-hub"]` failed in the built image:

    Error: Cannot find module '/workspace/workflow-hub'

Fixed with `RUN npm link --ignore-scripts` after `npm prune`, which links the
root package's bins into the global prefix. Verified in-container:
`which workflow-hub` → `/usr/local/bin/workflow-hub`, and the CMD starts the
hub (`Workflow hub listening at http://127.0.0.1:46027`). Pinned.

#### Defect 5 — symlinked `bin` entries silently no-op'd the daemons (product defect, fixed in `src/`)

Every installed `bin` is a **symlink** (`/usr/local/bin/workflow-opencode-server`
→ `.../dist/cli/opencode-server.js`). Node does not resolve `argv[1]` through
it, so the entrypoint guards never matched. `workflow-opencode-server` started,
no-opped, and **exited 0** — the daemon the image would serve as the C1 plane
did nothing, with a success code (measured in-container before the fix; after
the fix it correctly fails closed, `EXIT=1`, on the missing upstream key).

Fixed with a shared realpath-aware helper `src/cli/entrypoint.ts`
(`isEntrypoint`), wired into `opencode-server`, `opencode-attach`, `rsi`,
`web-launch`, and `acp-remote`. Regression-pinned by
`test/cli-entrypoint.test.ts` (executes the symlink case). This defect is
independent of the image — it hit every globally installed bin on every host
— and is the reason the earlier "the daemon started" reading was wrong.

#### Defect 6 (context hygiene) — nested `node_modules` entered the build context

A bare `node_modules` pattern in `.dockerignore` matches only the root;
`mcp-toolbox/node_modules` and `mcp-toolbox/apps/*/node_modules` were copied
into the context (verified by building a `COPY mcp-toolbox` probe). Host
trees are stale and carry native binaries. Fixed with `node_modules` +
`**/node_modules`. Pinned.

#### Defect 7 — the 198 MB opencode binary was not git-ignored

`.gitignore` ignored `infra/c0/image/opencode` (the C0 vendor path, line 9) but
**not** `images/control-plane/opencode` — the path `publish-image.yml`
downloads the release asset into. `git add -A` would therefore have staged a
198 MB dev-channel binary into the repo. Fixed: both vendor paths are ignored
(measured 2026-10-09; `git check-ignore images/control-plane/opencode` now
resolves). Pinned by `test/control-plane-dockerfile.test.ts`.

#### The C1 composition decision (known-state item 3)

**The current single-process image is NOT the C1 plane, and it is NOT certified
as one.** C1 (`2026-09-25 spec` §8/§10) is hub + `opencode-server` daemon +
gateway + broker + a **contained** `opencode serve`, with the gateway as the
single ingress front door. The image's CMD is the **hub only**, and the hub
binds an **ephemeral loopback port** (`server.listen(0, "127.0.0.1")`,
`src/integrations/hub-http.ts:259`) — it does not serve 4096.

**Why C1 was not implemented in this change (measured, not assumed):**

1. `createOpencodeServerRuntime` launches `opencode serve` through
   `launchContainedAcpAgent`, which **requires an `enforced` containment
   boundary** (`src/adapters/acp-contained-agent.ts:63`:
   "contained ACP agent launch requires an enforced containment boundary").
2. The reference container cannot provide it: installing `bubblewrap` is not
   enough — the default (non-privileged) container blocks the namespace
   syscalls (`bwrap: Creating new namespace failed: Operation not permitted`,
   measured; the same "no bwrap" condition the runtime reports at image
   start).
3. No same-process single-port supervisor over {hub, gateway, serve} exists
   in the repo (`src/cli/workflow.ts` spawns *separate* processes; the gateway
   binds its own ephemeral port).

**What the artifact therefore is:** a **qualified partial** — the hub authority
runs, the toolchain and guard are intact, opencode is vendored and
version-pinned. It is **not** a deployable C1 plane, and the instance must not
deploy it as one. The Dockerfile header and CMD comment state this, and the
`docs/PARKED_AND_LIMITATIONS.md` row records it.

**Two candidate implementations for the operator (decision input, not taken):**

- **(A) `SupervisorContainment`** — an opt-in `enforced` containment backend
  that delegates to the OS boundary the container already provides (the
  process is contained by the container/pod, so the in-container boundary is
  the container itself). Preserves the single-image, single-port C1 shape.
  Needs: a new backend class, an explicit opt-in env (never a silent default),
  and a probe that the delegated boundary is real.
- **(B) Split the plane** — hub (internal, no ingress) + a second container /
  replica running the `opencode-server` daemon behind the gateway. Matches
  the recorded "container is the boundary" idea with two boundaries, at the
  cost of a second service definition and loopback-across-containers wiring.

Option A is the smaller open-side change and keeps the instance seed (one
image, one ingress port 4096) truthful.

**Also recorded (not fixed, out of one-way scope):** the instance pipeline
(`instances/azure/`) still names the image as a C1 plane; it must not be
deployed until C1 lands. No work-specific values entered this repo.

**Verification (local, this session — commands + verdicts):**

- `podman build -f images/control-plane/Dockerfile -t workflow-cp:test .` →
  **green** (`Successfully tagged localhost/workflow-cp:test`,
  `6e53a1c5a2ff…` after the fixes; `e6a97300f379…` with the bin link).
- `podman run … workflow-cp:test` → hub entrypoint resolves and starts
  (`Workflow hub listening at http://127.0.0.1:<ephemeral>`).
- `podman run … sh -c 'opencode --version'` → `opencode v2.0.10`.
- `podman run … sh -c 'workflow-opencode-server'` pre-fix → silent `0`;
  post-fix → fails closed (`EXIT=1`, missing upstream key).
- `node --import tsx --test test/control-plane-dockerfile.test.ts` → 6/6 pass.
- `node --import tsx --test test/cli-entrypoint.test.ts` → 2/2 pass.
- `node --import tsx --test test/publish-image-workflow.test.ts` → 8/8 pass.
- `npm run lint` exit 0; `npm run typecheck` exit 0.

**Honest residual:**

- **No in-container plane probe** (task item 2): the image runs the hub, but
  the hub's `/api/info`-style health, 401, and SSE checks belong to the
  **opencode server**, which this image does not serve on 4096. The C0 record
  (`infra/c0/README.md`) already proves stock `opencode serve` on 4096 answers
  401 + `/api/info` + SSE **through ingress**; this image does not yet place
  that server behind 4096, so the full plane's runtime behavior is unproven
  here.
- **The first tagged publish run remains the live verification** of the
  workflow + buildx path (GHCR, the release-asset download, the digest record).
  This entry verifies the **build** with podman; the workflow's GitHub-side
  steps are still unrun (unchanged from L9).
- **The C1 composition is unbuilt** (above) — the single largest open item on
  the deploy path.

**Refs:** `images/control-plane/Dockerfile`; `.dockerignore`;
`src/cli/entrypoint.ts`; `test/control-plane-dockerfile.test.ts`;
`test/cli-entrypoint.test.ts`; `docs/PARKED_AND_LIMITATIONS.md`;
`docs/ledger/w149-publish-digest.md`; the 2026-09-25 and 2026-09-26 specs.

---

### Supersession (2026-10-09, task 3 of the C1 deploy plan): option A adopted; the C1 gap is closed

**This section supersedes the "not a deployable C1 plane" conclusion above; the
earlier record is left as written (append-only).**

The operator adopted **option A (`SupervisorContainment`, realized as the
`workflow-plane` process supervisor + the delegated `container-boundary`
containment backend)**; the decision is recorded in
`docs/ledger/control-plane-c1-deploy-plan.md` Appendix B (D1-D6) and the
implementation in Appendix C.

- The former `images/control-plane/Dockerfile` "honest C1 gap" header is
  superseded by a dated note in place: `CMD ["workflow-plane"]` starts the hub
  **and** the OpenCode server daemon (contained `opencode serve` + authority
  broker + gateway), with the gateway bound to the ingress front door
  (`0.0.0.0:4096`).
- The reference-container objection (bubblewrap cannot create a nested
  namespace inside a pod) is answered by the delegated backend
  (`src/containment/container-boundary.ts`), selected by the INSTANCE via
  `WORKFLOW_CONTAINMENT_BACKEND=container-boundary`; the pod is the boundary.
- `USER node` (D6) and a pre-created node-owned `/home/node/.workflow` state
  root; the Azure Files state root (`WORKFLOW_OPENCODE_SERVER_HOME`) stays an
  instance value, never baked.

**Residual that remains open at this point:** the in-container loopback probe
result is recorded in `docs/ledger/control-plane-c1-deploy-plan.md` Appendix C
(build green; 401 / 200 `/api/info` / SSE `text/event-stream` inside a pod); the
live ACA probe (plan task 3.1) remains the measurement that upgrades any
pod-side status line. Until 3.1 runs, the image is pod-loopback-verified, not
ingress-verified, and no `enforced` label is claimed for deployed pods.

---

### Supersession + fix (2026-10-10): the vendored fleet is installed at deploy time

**Root cause (measured).** The plane advertised only the OPENCODE STOCK agents
and commands. `/api/agent` on the live plane listed exactly `build, general,
explore, compaction, title, summary, plan` and `/api/command` only `init,
review`; the composed config document was empty (`.../config/opencode/opencode.json`
document `null`). The custom fleet (`decompose`/`executor`/`retrospective`/
`reviewer` + `/decompose` `/retro` `/review-diff` `/rsi-loop`) never loaded.

Why: the fleet is vendored under `assets/opencode-fleet/` (W086, `manifest.json`,
15 entries) and deployed by the operator-invoked `workflow install fleet`
(`src/cli/install.ts:16` → `installFleet`), which writes agents/commands into
`~/.config/opencode/{agents,commands}`. The plane, though, runs `opencode
serve` with `XDG_CONFIG_HOME=<stateDir>/config`
(`src/integrations/opencode-server-runtime.ts:160,181-183`), and OpenCode reads
its global config from `Global.Path.config = xdgConfig/opencode`
(`opencode-src packages/core/src/global.ts:13,26,64`), scanning
`{agent,agents}`/`{command,commands}` there
(`packages/opencode/src/config/agent.ts:13`, `command.ts:15`). That isolated
config dir received only the hub-written `opencode.json` — nothing ever
installed the fleet into it. `installFleet` was referenced only by the CLI
(`install.ts`, `doctor.ts`), never by the plane supervisor
(`src/cli/plane.ts`) or the OpenCode runtime.

**Fix.** Both hub-owned OpenCode lanes now install the vendored fleet into the
config dir they compose, at launch, from the in-repo assets:

- `src/integrations/fleet-payload.ts` — new shared, exported
  `installFleetIntoOpencodeConfig(configDir)` (agents/commands only,
  `force: true`; the config dir is hub-owned and regenerated, so no operator
  edits to preserve). Both lanes call this ONE definition.
- `src/integrations/opencode-server-runtime.ts` — calls it right after the
  `opencode.json` write; injectable via `options.installFleetImpl` (tests).
- `src/integrations/acp-runtime.ts` — calls the same helper after the ACP lane's
  config write, for the local TUI and the in-plane hub reviewer runtime.

`src/integrations/fleet-payload.ts` also gained a `kinds` filter so the
config-dir install never touches the workspace-owned docs bundle
(`<workspace>/docs/agents`, install-if-missing, repo-owned living files).
Fail-closed: a malformed manifest throws and refuses the runtime.

**Verification (this session):**

- `node --import tsx --test test/install-doctor.test.ts` → 11/11 (new
  `kinds` filter test).
- `node --import tsx --test test/opencode-server-runtime.test.ts` → 5/5,
  including a launch test that asserts `agents/reviewer.md` and
  `commands/review-diff.md` land in `<stateDir>/config/opencode/` and logs
  `[fleet] installed 8 vendored agent/command file(s)`.
- `node --import tsx --test test/acp-runtime-args.test.ts
  test/install-surface-docs.test.ts test/opencode-server-runtime-downgrade.test.ts`
  → 32/32 across the focused set after the shared-helper refactor.
- `npm run lint` exit 0; `npm run typecheck` exit 0.

**Residual:** the fix is unit-verified (config dir populated). The live proof —
`/api/agent` on `code.ultus.net` returning the fleet agent names after the
next image deploy — remains the measurement that closes this on the plane.

**Refs:** `src/integrations/opencode-server-runtime.ts`;
`src/integrations/acp-runtime.ts`; `src/integrations/fleet-payload.ts`;
`test/opencode-server-runtime.test.ts`; `test/install-doctor.test.ts`;
`assets/opencode-fleet/`; `opencode-src packages/core/src/global.ts`.

---

### Supersession + fix (2026-10-11): the plane mounts the whole toolbox and delivers skills

**Gap (measured, spec-vs-implementation).** The plane image ships the full
`mcp-toolbox/` and specification §11 of
`docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`
("the full `mcp-toolbox/` ships inside the plane image … Hub-written metered
config wires the servers over loopback inside the container") requires the
hub-written config to carry them. Two paths did not reach the plane:

- **Toolbox/MCP servers.** The plane lane's `createOpencodeServerRuntime`
  composed only the skill-delivery floor (`workflow-guard-mcp` + `skills-mcp`;
  `toolbox-catalog.ts` `declaredSkillConnectors`), and `OpencodeServerRuntimeOptions`
  had NO `settings` field, so operator-declared MCP servers reached the ACP/TUI
  lane (`acp-runtime.ts:428` `mcpServers: enabledMcpServers(options.settings)`)
  but never the daemon. 14 of the 16 vendored servers were unreachable on the
  plane.
- **Skills.** `resolveSkillsMount()` mounts skills-mcp only when the operator's
  `SKILLS_MCP_DIR` (default `~/.agents/skills`) already exists
  (`acp-runtime.ts:963-985`). The image seeds no such directory, so on a fresh
  pod the mount resolved `undefined` and no skills — including the hub's own
  generated `workflow-toolbox` skill — were delivered.

**Fix.**

- `src/integrations/toolbox-catalog.ts` — new `toolboxCatalogMounts(catalog,
  {disabled, alreadyMounted})`: the FULL built catalog as stdio mounts (built
  entries only, operator-disabled wins, `alreadyMounted` dedupes skills-mcp).
- `src/integrations/opencode-server-runtime.ts` — `OpencodeServerRuntimeOptions`
  gains `settings` (projected via `enabledMcpServers` → `mcpServers`, exactly the
  ACP lane's path) and `mountFullToolbox` (selects `toolboxCatalogMounts` over
  the declared floor, and ensures the skills store exists via `ensureSkillsMount`).
  The connector readable-path binds now compose independently of the skills
  mount, so the full toolbox's stdio children survive the boundary even with no
  operator skills dir.
- `src/integrations/acp-runtime.ts` — new `ensureSkillsMount({root,home,exists})`:
  creates the hub-owned `~/.agents/skills` when absent, then resolves the mount;
  fails closed (undefined) when the skills server build is missing or the home
  is read-only. The ACP/ambient lane keeps the strict `resolveSkillsMount`
  posture.
- `src/cli/opencode-server.ts` — plane mode passes `mountFullToolbox: true` and
  `settings: loadSettings({ workspace })`. Non-plane mode is byte-identical.

**Verification (this session):**

- `node --import tsx --test test/opencode-server-runtime.test.ts` → 7/7, incl. (a)
  a real `opencode serve` launch asserting the config's `mcp` map carries the
  full toolbox (`workflow-guard-mcp`, `git-intelligence-mcp`,
  `project-memory-mcp`), the operator-enabled server, and NOT the
  operator-disabled one; and (b) a default-lane parity launch with
  `SKILLS_MCP_DIR` pointed at a nonexistent path asserting NO connectors and NO
  skills mount compose — pinning that a non-plane daemon without a skills store
  stays byte-identical (the review-caught regression, fixed).
- `node --import tsx --test test/toolbox-catalog.test.ts test/skill-delivery.test.ts`
  → 11/11 (new `toolboxCatalogMounts` and `ensureSkillsMount` tests).
- Focused set (runtime, runtime-downgrade, toolbox-catalog, skill-delivery,
  install-doctor, plane-supervisor, acp-runtime-args, install-surface-docs)
  → 61/61; `npm run typecheck` exit 0; `npm run lint` exit 0.

**Residual:** unit-verified (config map + store). Two plane failure modes stay
noted, not fixed here: (i) if the skills store cannot be created (read-only
home), `skillsMount` stays undefined while `alreadyMounted: ["skills-mcp"]`
still suppresses skills-mcp from the full-catalog mount, so skills-mcp mounts
nowhere (pre-existing delivery-exclusion behavior); (ii) `ensureSkillsMount`
creates the directory before resolving, so an absent skills server build leaves
an empty store behind. The live proof — the plane's `/api/agent`/`/api/command`
returning the fleet AND the composed MCP tool surface carrying the toolbox
servers after the next image deploy — remains the measurement that closes this
on the plane.

**Refs:** `src/integrations/toolbox-catalog.ts`;
`src/integrations/opencode-server-runtime.ts`; `src/integrations/acp-runtime.ts`;
`src/cli/opencode-server.ts`; `test/opencode-server-runtime.test.ts`;
`test/toolbox-catalog.test.ts`; `test/skill-delivery.test.ts`;
`docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`
§11.

---

### Live deploy + measurement (2026-10-11): v0.1.6 closes the fleet, toolbox, and skills gaps on the plane

**Deployed.** v0.1.6 was cut at `f025a779` (main after PR #514 + #515), the
qualified opencode asset attached to the release, `publish-image` run
`38088290286` green, digest recorded
`sha256:b035b231d767a75ab5093d4877dd905fed14e856c9ed3b9043d2f53981500678`.
The csh-dev instance pinned that digest (AzDO PR #1157 to `main`; deploy run
`3721` succeeded), revision `csh-dev-plane--0000013`, Running, min 1 / max 1.

**Measured on `code.ultus.net` (the gaps this ledger recorded are now closed):**

- Fleet agents load: `/api/agent` returns `build, general, explore, compaction,
  title, summary, plan, decompose, executor, retrospective, reviewer` (the four
  vendored agents are present, PR #514).
- Fleet commands load: `/api/command` returns `init, review, decompose, retro,
  review-diff, rsi-loop` (the four vendored commands).
- The full toolbox is mounted and connected: `/api/mcp` reports all 16 vendored
  servers `connected` (`workflow-guard-mcp`, `git-intelligence-mcp`,
  `project-memory-mcp`, `skills-mcp`, ...), and `/api/config` carries the same 16
  under `mcp.servers` (PR #515).
- Skills delivery is armed: the config composes `skill: deny` (single delivery
  path via `read_skill`) with `skills-mcp` mounted.

**Custom-domain rebind (pre-existing, unfixed).** The redeploy re-PUT dropped
`ingress.customDomains` to null (`infra/modules/plane.bicep` declares none);
`code.ultus.net` and `hub.ultus.net` were re-bound `SniEnabled` with the
`cf-origin-ultus` cert after deploy. Making the bindings declarative so a
redeploy does not drop them is a recorded follow-up.

**Still open (measured gap).** The Desktop "could not connect" root cause — a
credential-less CORS preflight hitting the auth gate first (`OPTIONS /api/info`
returns `401`, measured live) — is fixed in code (`isCorsPreflight` pass-through
in `opencode-server-gateway.ts`) but NOT in v0.1.6; it ships in the next image.

**Refs:** `docs/ledger/control-plane-c1-composition.md` (this entry);
`src/integrations/opencode-server-gateway.ts`; the v0.1.6 release; the csh-dev
pin (AzDO #1157).

---

### Live deploy + measurement (2026-10-11, later): v0.1.7 closes the CORS gap; the Desktop can connect

**Deployed.** v0.1.7 was cut at `f97b6ae6` (main after PR #516), the qualified
opencode asset attached, `publish-image` run `38090203162` green, digest
`sha256:27fd0b262a2d001144ba23872d8119449e47768fb3ea112cce9ddeb86679a1ab`.
The csh-dev instance pinned it (AzDO PR #1158 to `main`; deploy run succeeded),
revision `csh-dev-plane--0000014`.

**Rollout collision (measured, remedy recorded).** On the redeploy the new
revision 14 crash-looped: `opencode serve exited before becoming healthy (1)`
with empty stderr, `[fleet] installed 0 vendored agent/command file(s)`, then
`[plane] opencode-server exited — shutting the plane down`, 6 restarts,
`ActivationFailed`. Revision 13 (v0.1.6) stayed Healthy at weight 0 throughout,
sharing the same Azure Files state home (`WORKFLOW_OPENCODE_SERVER_HOME`). The
image was verified CORRECT off-plane: the gateway fix is present in
`/app/dist/integrations/opencode-server-gateway.js`, and a clean in-image
`workflow-opencode-server` launch installs `8` fleet files and binds
`http://127.0.0.1:4096`. **Inferred cause (not isolated):** concurrent revisions
sharing one over-mounted persistent state home, so the new revision's `opencode
serve` cannot start while the old revision's server holds that state. Empty
stderr means the mechanism is inferred from the correlation plus the remedy, not
directly observed. **Remedy that worked:** `az containerapp revision deactivate`
revision 13, then `az containerapp revision restart` revision 14; the fresh
replica came up Running/Healthy at weight 100 with `0` restarts.

**Measured on `code.ultus.net` after the fresh replica (the CORS gap is now
closed; the prior entry's "ships in the next image" is discharged):**

- CORS preflight passes: `OPTIONS /api/info` with `Origin: oc://renderer` +
  `Access-Control-Request-Method: GET` returns `204` with
  `access-control-allow-origin: oc://renderer` and
  `access-control-allow-headers: authorization` (both via `code.ultus.net` and
  the raw ACA FQDN; Cloudflare passes the preflight through). A bare `OPTIONS`
  (no negotiation headers) still returns `401` with `www-authenticate`, so only
  a genuine preflight is passed through.
- The post-preflight request works: authenticated `GET /api/info` with `Origin:
  oc://renderer` returns `200` with `access-control-allow-origin: oc://renderer`.
- The hub lane is untouched: `hub.ultus.net` with auth returns `200` (hub UI
  HTML + CSP), unauthenticated returns `401`.
- Fleet and toolbox survive the redeploy: `/api/agent` returns the fleet
  (`decompose, executor, retrospective, reviewer` among the stock set),
  `/api/command` returns the fleet commands, and `/api/mcp` reports `16`
  servers. (A probe issued in the first seconds after a fresh replica returns
  an empty list — server warmup; the settled probe carries the full surface.)

**Custom-domain rebind (pre-existing, unfixed).** The redeploy re-PUT again
dropped `ingress.customDomains` to null; `code.ultus.net` and `hub.ultus.net`
were re-bound `SniEnabled` with the `cf-origin-ultus` cert. Making the bindings
declarative remains a recorded follow-up, now joined by the per-revision
state-home isolation follow-up (plausibly the same shared-state class as the
PID-based `acquireInstanceLock` defect; that equivalence is an inference, not a
measurement).

**Refs:** `src/integrations/opencode-server-gateway.ts`; the v0.1.7 release; the
csh-dev pin (AzDO #1158); `src/integrations/opencode-server-runtime.ts` (state
dir); `images/control-plane/Dockerfile`.

### Plane LSP wire + ACP fleet-install seam (2026-10-11)

**Source:** the operator "LSP wire" directive and review follow-up
`34a0ff8e` (the ACP lane installed the vendored fleet inline with no seam).
Append-only; supersedes nothing above.

#### LSP: the gap and the wire

opencode v2 disables **every** language server when the config `lsp` key is
absent (`packages/opencode/src/lsp/lsp.ts`: `if (!cfg.lsp) "all LSPs are
disabled"`). The plane's hub-written config
(`src/integrations/opencode-agent-config.ts` `meteredOpencodeConfig`) omitted
the key, so the deployed plane had no LSP at all. Even with the key set, the
built-in `typescript` server resolves `typescript-language-server` from
opencode's own npm cache (`Npm.which`) and `tsserver.js` from the WORKSPACE's
`node_modules` (`Module.resolve`) — neither exists offline in a fresh pod.

The wire (three coordinated parts):

- **Config** — `meteredOpencodeConfig` gains an `lsp` option, emitted verbatim
  when supplied and absent otherwise (byte-identical default). The plane CLI
  (`src/cli/opencode-server.ts`, plane mode only) passes
  `planeLspConfig()` (`src/integrations/plane-lsp.ts`): a `typescript` entry
  that OVERRIDES the built-in (same id ⇒ keeps the built-in's `root`
  resolution) with an explicit command pointing at the image-baked server and
  an `initialization.tsserver.path` pinned to the image's `tsserver.js`, so it
  starts even when the opened workspace has no TypeScript installed.
- **Image** — `images/control-plane/Dockerfile` installs pinned
  `typescript@5.9.3` + `typescript-language-server@6.0.2` into the
  `/usr/local` global prefix (bound under `/usr`); the build runs
  `typescript-language-server --version` to fail closed. The config's path
  constants and the Dockerfile lines are pinned to each other by
  `test/plane-lsp.test.ts`.
- **Launch env** — when LSP is composed the contained launch pins
  `OPENCODE_DISABLE_LSP_DOWNLOAD=1` (opencode source
  `packages/opencode/src/effect/runtime-flags.ts`:
  `disableLspDownload: bool("OPENCODE_DISABLE_LSP_DOWNLOAD")`), so an
  unprovisioned built-in an operator's file type happens to match fails
  closed to "unavailable" instead of fetching from the network mid-session.
  The launch also sets `PATH` (`PLANE_LSP_DEFAULT_PATH`) because the contained
  launch forwards an env block with no ambient PATH and the baked server is a
  `#!/usr/bin/env node` script — without PATH the shebang cannot find `node`
  (measured locally: `env -i <bin> --version` fails with "node: No such file",
  `env -i node <cli.mjs> --version` succeeds).

**Evidence (local, this revision):** typecheck + lint exit 0;
`test/plane-lsp.test.ts` 5/5; `test/opencode-server-runtime.test.ts` 7/7 — the
launch test drives the real pinned opencode (v2.0.10) through the injected
boundary WITH `lsp: planeLspConfig()` composed, and the server reaches healthy,
proving the pinned binary accepts the block (a bad shape hard-fails startup)
and the block survives into `opencode.json`. The override's merge semantics are
read directly from the pinned opencode source
`packages/opencode/src/lsp/lsp.ts` (`servers[name] = { ...existing, id, root:
existing?.root ?? …, extensions: item.extensions ?? existing?.extensions ?? [],
spawn: custom }`); the config declares `extensions` explicitly so the file-type
gate does not depend on the merge. Honest limit: the LIVE end-to-end proof (a
real file touch producing a diagnostic over `code.ultus.net`) is a
deploy-gated follow-up — this entry claims config/runtime/acceptance, not a
live LSP session.

#### LSP live probe (2026-10-11) — deploy-gated, verdict pending

`test/plane-lsp-live-probe.test.ts` (gate `WORKFLOW_AZURE_PLANE_LSP_PROBE=1`,
reusing `WORKFLOW_AZURE_PLANE_URL` / `WORKFLOW_AZURE_PLANE_CLIENT_PASSWORD`)
is the live acceptance instrument for the wire above. Through ACA ingress it
asserts the plane is healthy (`GET /api/info` 200) and that `GET /api/lsp` —
the only token-free HTTP LSP route in opencode v2 (`getLsp` -> `LSP.status()`,
returning `LSP.Status[] = {id, name, root, status: "connected" | "error"}`) —
is reachable through the gateway and well-formed (HTTP 200 + a JSON array). It
does **not** fail on an empty array: opencode answers `[]` until an LSP client
is spawned, and a client is spawned only by a file touch in a token-spending
write/edit turn. When a `typescript` entry is present it must read
`"connected"`. Register rows `c1-plane-lsp` and `c1-plane-lsp-diagnostic`
(`docs/PROBE_VERDICTS.json`), both `pending`/`unqualified`. The live
**diagnostic** verdict (a real file touch producing a diagnostic) stays pending
an operator run with a model key: the diagnostic arm is gated separately
(`WORKFLOW_AZURE_PLANE_LSP_DIAGNOSTIC=1`) and is an honest documented `skip`
that asserts nothing, so no live LSP session is claimed here yet.

#### ACP fleet-install seam (review follow-up `34a0ff8e`)

The ACP lane called `installFleetIntoOpencodeConfig` inline with no injectable
seam (`acp-runtime.ts`). It now composes through a named export
`installAcpVendoredFleet` (mirroring the server lane's `installVendoredFleet`)
and an `AcpRuntimeOptions.installFleetImpl` seam. `test/acp-runtime-agent.test.ts`
now asserts the ACP seam installs the same agent/command set as the server
lane (never docs). Evidence: `test/acp-runtime-agent.test.ts` 15/15.

**Refs:** `src/integrations/plane-lsp.ts`; `src/integrations/opencode-agent-config.ts`;
`src/integrations/opencode-server-runtime.ts`; `src/cli/opencode-server.ts`;
`src/integrations/acp-runtime.ts`; `images/control-plane/Dockerfile`;
`packages/opencode/src/lsp/lsp.ts` (v2.0.10).

### Per-revision state-home isolation (2026-10-11)

**Source:** the recorded follow-up in the v0.1.7 entry above ("Custom-domain
rebind" section, the per-revision state-home isolation follow-up). Append-only;
supersedes nothing.

A redeploy/rollout can leave the previous Container App revision and the new
one sharing the SAME fixed state root — `WORKFLOW_OPENCODE_SERVER_HOME`
resolves one path on one Azure Files mount — so a fresh revision could pick up
(and clobber) the prior revision's discovery file and OpenCode DB.

The wire:

- **Env contract** — the instance supplies its revision identity in
  `WORKFLOW_PLANE_REVISION` (`WORKFLOW_PLANE_REVISION_ENV` in
  `src/integrations/opencode-server-discovery.ts`; an instance value, never
  baked into the image). Absent, empty, or whitespace-only, the state home is
  **byte-identical** to the pre-revision root — the ambient daemon and every
  pre-revision deployment keep the exact path they had.
- **Helper** — `opencodeServerStateHome(base, revision?)` appends one
  filesystem-safe segment (lowercased, unsafe runs collapse to `-`, edge
  separators trimmed, capped at 64 chars) only when a non-empty identity is
  supplied. An identity that sanitizes to nothing **throws** rather than
  silently sharing the base path (fail closed). The segment can never be `.`,
  `..`, or absolute.
- **Call sites** — the daemon (`src/cli/opencode-server.ts`) scopes both its
  discovery file and its OpenCode DB (`stateDir` runs off `stateHome`); the
  in-pod hub-UI live reads (`src/ui/web.ts`: `/api/settings/mcp/live`,
  `/api/usage/sessions/live`, `/api/sessions/compact`) scope the same way so
  they read the revision's own state, not another revision's.

**Evidence:** `test/opencode-server-state-home.test.ts` 6/6 (byte-identical
default; isolated suffix; sanitization/traversal-safety; fail-closed on
unsanitizable input; discovery-path consistency; env-name convention);
`test/opencode-server-launcher.test.ts` + `test/plane-supervisor.test.ts` +
`test/opencode-live-state.test.ts` 37/37; `npm run typecheck` and
`npm run lint` exit 0. (`test/opencode-server-runtime.test.ts` has one failure
that pre-exists on the base branch — a toolbox-build fixture dependency,
reproduced with this diff stashed — not caused by this change.)

**Honest limit / deploy follow-up:** the csh-dev side must set
`WORKFLOW_PLANE_REVISION` (the ACA revision name, e.g.
`csh-dev-plane--0000014`) on both the `workflow-opencode-server` daemon and the
hub processes (it is inherited, not scrubbed, so the hub UI's live reads see
it). Until that wire-up is verified live, the isolation is config/runtime-
acceptance only; the ledger follow-up is not closed.

**Refs:** `src/integrations/opencode-server-discovery.ts`;
`src/cli/opencode-server.ts`; `src/ui/web.ts`;
`test/opencode-server-state-home.test.ts`.
