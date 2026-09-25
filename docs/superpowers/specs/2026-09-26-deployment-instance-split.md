# Open core, deployment instance — the repo-placement split

**Date:** 2026-09-26 · **Status:** decision recorded + seed template
(`instances/azure/`, Draft). No product code accompanies this spec. ·
**Evidence base:** `AGENTS.md` (kernel-purity rule, verification discipline),
`LICENSE` (MIT, added 2026-09-26), `package.json` (`license` field),
`docs/superpowers/specs/2026-09-25-azure-container-jobs-remote-sandbox-design.md`
(the plane design this complements), `infra/c0/README.md` (C0 verdicts),
`src/ui/web-agents.ts` (`azure_foundry` provider already supported).

---

## 1. Motivation and scope

The operator's situation: the control plane is an **open project**
(`github.com/ultus-net/workflow`, MIT) while the Azure deployment material —
bicep parameters, pipelines, service connections, secrets, org values — belongs
in a **separate project on the work Azure DevOps account**. Hosting and model
inference are paid work-side (`azure_foundry` is already a supported goose
provider), the tools stay the operator's, and the local-first path is a
permanent requirement for the open and personal side.

**In scope:** where deployment-instance material lives; the contract between
open core and instance; publishing/pinning mechanics; disposition of existing
instance material.

**Non-goals:** the remote-plane design itself (owned by the 2026-09-25 spec);
any `enforced` claim (still probe-gated per that spec's C/P tracks).

## 2. The seam (product vs instance)

| | Open core (GitHub, personal, MIT) | Deployment instance (AzDO, work) |
| --- | --- | --- |
| Content | Product code: kernel, application, adapters, integrations, containment, surfaces, toolbox. Generic parameterized bicep modules (`infra/`). The qualified reference probe record (`infra/c0/`). The instance seed (`instances/azure/`). | `.bicepparam` values, pipeline YAML, service connections, Key Vault references, org/project/subscription names, posture decisions (agent kinds, provider endpoints, budgets), secrets. |
| Knows about the other | Nothing | Pinned open artifact references (tag, image digest) |
| License | MIT (2026-09-26) | Work-owned |

## 3. The dependency rule (one-way)

The work instance **consumes pinned open artifacts**: bicep modules at a pinned
tag, container image pinned by digest. Nothing flows the other way — the open
repo must contain nothing work-specific (no org URLs, subscription IDs,
environment names, work secrets). This is a greppable invariant, not a hope:
the only permitted work-side strings in the open repo are the word "instance"
in docs.

Reasons: (a) the tools remain the operator's, portable past employment;
(b) work's security story can be argued about a pinned, reviewed artifact
instead of a rebuild; (c) the exit path — re-pointing the same params at a
personal subscription — is a param change, not a rebuild.

## 4. Licensing

Root `LICENSE` added 2026-09-26 (MIT, copyright ultus-net) and `package.json`
gains `"license": "MIT"`. The toolbox packages already declared MIT; the root
was the gap. Without a root license the repo was all-rights-reserved and the
work tenant had no grant to run it — this closes that before deployment starts.

## 5. Publishing and pinning

- **Image:** built open-side from tagged releases, pushed to GHCR, consumed by
  digest. The instance never rebuilds the product image from source; what work
  runs is what was reviewed and released open-side.
- **Bicep modules:** single source stays in `infra/` open-side. The instance
  pipeline checks out the open repo at the pinned tag (two-checkout AzDO
  pipeline) and deploys those modules with instance params.
- Rejected: work-side image builds (splits the trust root, breaks the
  reviewed-artifact provenance chain).

## 6. Local-first guarantee

The in-process local surfaces (`workflow`, `workflow-hub`, `workflow-tui` over
stock-ACP OpenCode) remain the default and cannot regress because of this
split: the instance is additive, and the core gains no dependency on it. Losing
work access reverts to local use, never to breakage.

## 7. Disposition of existing instance material

`infra/c0/` stays open-side: it is the qualified C-track transport probe with
append-only verdicts (`infra/c0/README.md`), and it doubles as the
anyone-can-run reference deployment. Its env file class (`c0.env`) never leaves
the deploying machine (already gitignored). Future instance work seeds from
`instances/azure/` into the work repo rather than accumulating new
operator-specific material here.

  - Dated note (2026-09-26, operator direction, same day): `infra/c0/`
    EXTRACTS to the work instance repo once that repo exists and consumes the
    material — the open repo does not keep the test-deploy instance. The
    paragraph above is superseded in that respect. What survives unchanged is
    the verdict-preservation duty: the pinned recipe and the append-only
    verdict table move with the instance, the open side records the extraction
    with dated pointers, and git history remains the archive (§11 is the
    gated sequence).

## 8. The work-instance repo shape (seeded by `instances/azure/`)

- Two-checkout pipeline: self (instance values) + open repo at a pinned tag.
- Params hold values only; secrets ride Key Vault references (C0's ACA-managed
  secret was a probe shortcut; C1 targets Key Vault per the 2026-09-25 spec).
- Environments with approvals/checks carry the work posture.
- Traceability: work PRs link Boards items (`AB#`) and cite the open release
  tag consumed. Each platform hosts its own truth; no mirroring.

## 9. Security and social posture

- The control plane custodies credentials by design; inside the work tenant
  that warrants a security-review conversation before anything real runs
  (supply-chain trust of a public image, containment posture, permitted hosts).
- IP clarity: personal open-source work plus operating it in the work tenant
  should be explicitly sanctioned by the employer (operator action, before C1).
- Work pays hosting and inference; the open project stays independent of
  whether that continues (§6).

## 10. Open questions (requirements, not resolutions)

1. GHCR vs a private ACR mirror for the published image (provenance vs
   pull-cost/quota inside the work tenant).
2. Does the instance pipeline verify the digest against a recorded expectation
   (fail-closed pin check) or trust a pin file? Fail-closed is the repo's
   posture; the mechanism is undecided.
3. Secret custody work-side: Key Vault refs end-state, ACA secrets as the C0
   probe shortcut only.

## 11. Extraction sequence — strip `infra/c0/` into the work instance repo (recorded 2026-09-26, gated; not executed)

**Readiness gates (all must hold before the strip commit):**

1. The work AzDO instance repo exists, seeded from `instances/azure/`, and
   carries the extracted material: the bicep modules, the deploy script, the
   probe, and the C0 pinned-recipe + verdict tables (from
   `infra/c0/README.md`) as living instance docs.
2. The verdicts are preserved on the open side too: the 2026-09-25
   remote-sandbox spec's C-track gains a dated note — C0 executed and PASSED
   2026-09-25 (australiaeast), record retained in git history at the pre-strip
   sha named by the strip commit. History is the archive; nothing is silently
   rewritten.
3. The reference sweep is clean at execution time. Known today (2026-09-26
   sweep, complete as of this writing): this spec — the §2 seam-table cell
   naming `infra/c0/` (stale post-strip; `infra/` empties), the §7 dated
   note, the Evidence-base line citing `infra/c0/README.md`; `.gitignore`'s
   three `infra/c0/` rules (removed by the strip commit);
   `instances/azure/README.md` (the `c0.env` discipline pointer, already
   reworded to drop the path dependency); and the W147 dated note. `src/` and
   `test/` carry no references (verified). The strip commit updates every one
   of these — `.gitignore` rules removed, the §2 cell and Evidence-base line
   re-pointed at the instance repo and git history.
4. The W148 ledger entry closes with the pre-strip sha in the strip commit
   message.

**The strip commit:** deletes `infra/c0/` (README, `infra.bicep`,
`app.bicep`, `deploy.sh`, `probe.mjs`, `image/`), updates the pointers above,
and carries the pre-strip sha in its message.

**Honest consequence, stated:** after the strip the open repo no longer ships
a runnable reference deployment — adopters start from `instances/azure/` and
their own modules, or check out the pre-strip tag for the C0 reference. If
reusable generic modules emerge from instance work, they may be contributed
back open-side under §5 (generic values only).