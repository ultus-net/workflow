# CI design — the open repo's verification tiers

**Date:** 2026-09-26 · **Status:** design recorded; implementation is W150
(pending the operator's two decisions below). · **Evidence base:** `AGENTS.md`
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

## 6. Operator decisions pending (W150 scope hangs on these)

1. **Merge-gate scope:** Tier A only, or A+B as required checks?
   Recommendation: **A+B** — Tier A alone proves formatting and compilation,
   not behavior; Tier B is bounded by the LESS-0051 design, and GitHub-hosted
   runners are free for public repos.
2. **Tier C now or deferred?** Recommendation: **defer the full-suite arm**
   until the first real release; the probe arms stay manual regardless (spend
   + per-version verdict discipline).

## 7. Implementation sketch (W150)

- `.github/workflows/ci.yml`: job `gate` (Tier A) + job `evidence` (Tier B,
  pending decision 1), Node 22 + corepack for `toolbox:verify`.
- `package.json`: `test:ci` script enumerating the curated suites.
- `release-gate.yml`: deferred per decision 2.
- Branch protection: required checks = the chosen tiers (operator configures
  in GitHub settings; CI defines the check names).
- `publish-image.yml`: drafted (W149); the publish arm of this design.

## 8. Honest residuals

- The publish workflow and Dockerfile are **unverified until the first tagged
  run** (the authoring environment has no docker); their design follows the
  C0 vendoring discipline (operator-attached qualified binary, sha pin,
  version-drift build failure).
- CI run logs are external evidence; the ledger's verification lines gain
  run URLs only when someone records them — CI cannot write the ledger
  (that is a feature: records stay operator-owned).
