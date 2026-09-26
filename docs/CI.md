# CI design — the open repo's verification tiers

**Date:** 2026-09-26 · **Status:** decisions recorded + tiers A/B implemented
(W155); tier C deferred per decision; publish machinery drafted (W149,
unverified until its first tagged run). · **Evidence base:** `AGENTS.md`
(verification commands, the full-suite resource directive, probe discipline),
`docs/HOST_ADAPTERS.md` (per-version probe verdicts),
`docs/superpowers/specs/2026-09-26-deployment-instance-split.md` (publish
flow), `TASKS.md` W137/W149 (prepare-tool behavior, publish machinery), the
LESS-0051 safety contract recorded across the e2e ledger entries.

---

## 1. Current truth

The repo has **no CI at all** today (`no .github/` as of 2026-09-26): every
verification is local, enforced by the workflow guard (verify gate +
fingerprinted five-axis review records). The first drafted workflow is
`.github/workflows/publish-image.yml` (W149): tagged release → GHCR image →
digest expectation recorded at the tag. This design decides what ELSE runs
where, and what CI is allowed to claim.

## 2. Constraints the design must respect (verified, not invented)

1. **The full suite is forbidden by default** (`AGENTS.md` resource
   directive): it spawns PTYs, agents, and hub daemons. CI may run it only
   where the directive's own exception points — explicit release gates.
2. **Probe discipline:** live probes are env-gated (`WORKFLOW_ACP_*`), cost
   real model spend, and their per-version verdicts are recorded by hand in
   `docs/HOST_ADAPTERS.md` and re-run on every version bump. CI must not
   silently spend; it may run probes only behind repository secrets AND an
   explicit trigger.
3. **The LESS-0051 contract is the CI-safety definition:** e2e suites written
   to it spawn no agents/PTYs, redirect HOME, bind port 0, and pin their
   teardowns — the ledger recorded that contract repeatedly, precisely so a
   bounded set can run unattended.
4. **Linux-only containment** (Bubblewrap backend): runners are
   `ubuntu-latest`; nothing in CI may imply macOS/Windows support.
5. **Fail closed:** a required-check failure blocks the merge; nothing in CI
   is advisory-with-bypass.
6. **The review control plane stays hub-local:** five-axis verdicts carry
   fingerprinted provenance (`src/review/provenance.ts`) that CI cannot
   reproduce; CI must not mint review-shaped evidence.

## 3. The tier model

| Tier | What | When | Contents |
| --- | --- | --- | --- |
| A — merge gate | lint, typecheck, build (`tsc -p tsconfig.build.json`), `toolbox:verify` | every PR + push to main | deterministic, no daemons, minutes |
| B — PR evidence | the curated CI-safe test set via `npm run test:ci` | every PR | the LESS-0051 e2e set + unit suites, **enumerated by name** |
| C — release gate | the FULL suite + env-gated live probes (secrets) | manual dispatch / tag builds only | the directive's own exception; never on PRs |
| D — publish | tag → image → GHCR → digest recorded at the release | `v*` tag push + manual | drafted (W149); first live run is its verification |

## 4. The test-set curation rule (the load-bearing decision)

`npm run test:ci` **enumerates suite files by name** in `package.json` — never
a glob. Adding a suite to CI is a deliberate, ledger-visible act: edit the
script, cite it in the work item. Rationale: the resource directive exists
because some suites spawn PTYs/agents/hubs; a glob would silently violate it
the first time someone adds a file to `test/`. This rule is what makes Tier B
honest: CI's green is the evidence that exactly the enumerated safe set
passed, not that "the tests passed".

## 5. What CI does NOT do

- No probe runs without repository secrets AND an explicit trigger (Tier C
  only); spend-bearing verification is never a side effect of a PR.
- No review verdicts: the five-axis review stays in the hub's review control
  plane; CI surfaces verification evidence only. (If a CI-reviewer bridge is
  ever built, it must carry the same fingerprint discipline — not this
  design's scope.)
- No full suite on PRs; no Windows/macOS jobs; no deployment of anything (Tier
  D only pushes artifacts; deploys belong to the instance repos, per the
  2026-09-26 split spec).

## 6. Operator decisions (recorded 2026-09-26)

1. **DECIDED — merge gate = Tier A + B.** Both `gate` and `evidence` jobs are
   required checks on PRs; `evidence` runs `npm run test:ci`.
2. **DECIDED — Tier C deferred.** `release-gate.yml` lands when the first
   real release happens; the live-probe arms stay manual regardless (spend +
   per-version verdict discipline).

## 7. Implementation (landed 2026-09-26, W155)

- `.github/workflows/ci.yml`: job `gate` (Tier A) + job `evidence` (Tier B,
  `needs: gate`), Node 22; pnpm pinned via `pnpm/action-setup@v4` reading
  `mcp-toolbox/package.json` (the toolbox declares
  `packageManager: pnpm@11.5.2` — corepack's default shim resolves a newer
  pnpm and pnpm refuses the mismatch, caught live in the first CI run
  2026-09-26); both on PRs and pushes to main.
- `package.json`: `test:ci` enumerating 21 suites by name — the 14
  LESS-0051-contract e2e suites (`e2e-admin`, `e2e-contained-shell`,
  `e2e-doctor`, `e2e-hub-bash`, `e2e-hub-routes`, `e2e-hub-schedule`,
  `e2e-hub`, `e2e-packaged-seat`, `e2e-prepare-tool`, `e2e-rsi-cli`,
  `e2e-settings`, `e2e-webapp-assets`, `e2e-web-service`, `web-scoping`) plus
  7 unit suites (`hub-rsi`, `hub-review`, `hub-runs`, `security-assurance`,
  `text-hygiene`, `contracts`, `acp-runtime-args`).
- `release-gate.yml`: deferred per decision 2.
- Branch protection: the operator flips the required-checks toggle in GitHub
  settings to name `gate` and `evidence` (CI defines the check names; the
  toggle is the operator's remaining click).
- `publish-image.yml`: drafted (W149); the publish arm of this design.

Precondition discovered during local verification: the curated set needs the
vendored toolbox BUILT — with install scripts skipped, `e2e-contained-shell`'s
guard seat fails closed (`workflow-guard-mcp is not built`). The evidence
job's `npm ci` (scripts ON) provides the build; the Dockerfile's
`--ignore-scripts` choice is deliberately different and justified in place.
Local verification of the full enumerated set: 97/97 pass (~33s) after
`node scripts/prepare-tool.mjs`.

Live-run preconditions (found in the first PR-#132 CI runs, 2026-09-26):
(1) pnpm must be pinned to the toolbox's declared version —
`pnpm/action-setup@v4` reading `mcp-toolbox/package.json` (corepack's
default shim resolves a newer pnpm and pnpm refuses the mismatch);
(2) the evidence job must INSTALL Bubblewrap — `ubuntu-latest` ships no
`bwrap`, and the containment suites correctly fail closed without it
("containment backend unavailable": `src/containment/linux-bwrap.ts` rejects
ENOENT rather than executing with ambient authority — the honest boundary
working as designed); Ubuntu 24.04's AppArmor unprivileged-userns
restriction is relaxed in the same setup step; (3) the evidence job must
also provision a headless secret-service keyring — W130's credential
custody test drives the real `secret-tool` D-Bus store, and without a
session bus + unlocked collection the control plane correctly answers 400
(gnome-keyring + dbus-x11 installed, dbus-launch +
`gnome-keyring-daemon --unlock --daemonize`, exported through $GITHUB_ENV).
The guard build precondition
turned out to be a REAL product defect: the root `postinstall` key sat at
package.json top level (outside `scripts`), so npm never ran the hook
anywhere — fixed by moving it into `scripts` (W137 dated correction).

## 8. Honest residuals

- The publish workflow and Dockerfile are **unverified until the first tagged
  run** (the authoring environment has no docker); their design follows the
  C0 vendoring discipline (operator-attached qualified binary, sha pin,
  version-drift build failure).
- CI run logs are external evidence; the ledger's verification lines gain
  run URLs only when someone records them — CI cannot write the ledger
  (that is a feature: records stay operator-owned).
