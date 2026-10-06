<!-- Ledger fragment: opened 2026-10-06 as a post-freeze W-item backfill (TASKS.md is frozen; live tracking is the GitHub Project). The canonical record is the split spec and issue #145; this file is the write-once per-item record. Append dated supersession notes, never rewrite. -->

### W147 - Open core / deployment-instance repo split (MIT root license, instance seed, split spec) (Complete) (2026-09-26)

**Source:** GitHub issue #145 (closed 2026-09-26); canonical design:
`docs/superpowers/specs/2026-09-26-deployment-instance-split.md`; landed in
PR #132 (merge `a0e1c42`, 2026-09-26) alongside W148's gated extraction and
W149's publish machinery.

**What landed:**

- **The seam contract** (spec §2): the product stays an open GitHub project
  (`github.com/ultus-net/workflow`, MIT) while the Azure deployment material —
  `.bicepparam` values, pipeline YAML, service connections, Key Vault
  references, org/project/subscription names, posture decisions, secrets —
  moves to a separate work-owned AzDO instance repo. The dependency rule is
  one-way (spec §3): the instance consumes pinned open-core artifacts; the
  open core never depends on an instance (spec §6, local-first).
- **MIT root license** (spec §4): `LICENSE` added at the repo root (MIT,
  copyright `ultus-net`, intro `584bd613`) and `package.json` gains
  `"license": "MIT"`. The toolbox packages already declared MIT.
- **The split spec** (`docs/superpowers/specs/2026-09-26-deployment-instance-split.md`,
  intro `5ee56dba`): motivation/scope, the seam table, the one-way dependency
  rule, licensing, the publishing-and-pinning scheme, the local-first
  guarantee, disposition of existing instance material, the work-instance repo
  shape, security/social posture, and the recorded resolutions to the open
  questions (§10).
- **The instance seed** (`instances/azure/`, intro `5ee56dba`; `verify-pin.sh`
  added in the refinement `d2161766`): `README.md` (the fill-in checklist and
  the consumes/provides table), `azure-pipelines.yml`, `params.bicepparam`,
  and `verify-pin.sh`. The seed is a generic starting skeleton copied into a
  fresh work AzDO repo; it deploys nothing on the open side.

**The pinning half (seed + open-side producer):** the seed's `verify-pin.sh`
binds a fail-closed expectation — it materializes the release-asset
`image-digest.txt` for the consumed tag and matches `sha256:[0-9a-f]{64}`.
The open-side producer of that asset is W149's publish workflow (spec §10 Q2);
W147 owns the seed's consumer side.

**Explicitly out of scope (owned elsewhere):** the `infra/c0/` strip into the
work instance repo is **W148** (issue #141) — recorded gated and **not
executed** (spec §11 lists its readiness gates and the reference sweep). W147
is complete on the open side without the strip; the two are separable.

**Evidence (all present on `origin/main`):** `LICENSE` (MIT, `584bd613`) and
`"license": "MIT"` in `package.json`; the spec file; and the four seed files
under `instances/azure/` (`README.md`, `azure-pipelines.yml`,
`params.bicepparam`, `verify-pin.sh`). `infra/` still holds `infra/c0/`
(W148's unexecuted strip), consistent with the seam being declared but the
extraction deferred. Issue #145 closed 2026-09-26.

**Honest status:** Complete on the open side. The instance seed is a DRAFT
template ("structure and contract only; the pipeline here deploys nothing
yet" — `instances/azure/README.md`), and `infra/c0/` still lives on the open
side until W148 executes its gated strip. No live instance repo exists yet;
the split's social/security review (spec §9) is an operator action before C1.

**Refs:** issue #145; PR #132; `docs/superpowers/specs/2026-09-26-deployment-instance-split.md`;
consumer chain W148 (issue #141) and W149 (issue #142).
