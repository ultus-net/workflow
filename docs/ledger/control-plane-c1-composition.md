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
