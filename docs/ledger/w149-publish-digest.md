<!-- Ledger fragment: opened 2026-09-30 as the W149 publish-digest correction record (issue #142). TASKS.md is frozen (post-freeze work tracks in the GitHub Project); write-once — append dated supersession notes, never rewrite. -->

### W149 - the publish workflow's recorded digest: single-prefix correction (Corrected + structurally complete; live verification remains the operator's first tagged run) (2026-09-30)

**Source:** GitHub issue #142 ("W149 - The open-side publish workflow"), the
defect verified in `.github/workflows/publish-image.yml`. The open-side half
of the split spec's §10 Q2 pin mechanism
(`docs/superpowers/specs/2026-09-26-deployment-instance-split.md`) is the
tag → GHCR push → digest record at that tag; its consumer is
`instances/azure/verify-pin.sh`.

**The defect (verified, not inferred):** the record step took
`IMAGE_DIGEST: ${{ steps.push.outputs.digest }}` — and
`docker/build-push-action`'s `digest` output is ALREADY `sha256:<64hex>` —
then wrote it with `printf 'sha256:%s\n' "$IMAGE_DIGEST"`, producing the
double-prefixed record `sha256:sha256:<64hex>`. It shipped silently because
`verify-pin.sh`'s `grep -oE 'sha256:[0-9a-f]{64}' | head -1` extracts the
inner hash and so still matched; the malformed expectation and the doubled
prefix in the release-note body were the observable wrongness.

**What landed (branch `fix/w149-publish-digest`, PR to be linked at open):**

- `.github/workflows/publish-image.yml` (the `Record the digest at the tagged
  release` step, ~lines 84-104): the write is now
  `printf '%s\n' "$IMAGE_DIGEST" > image-digest.txt` (single prefix — the
  value is written verbatim, not re-prefixed), preceded by a fail-closed
  assertion that the value matches `^sha256:[0-9a-f]{64}$` (else
  `::error::` + `exit 1`, so a malformed digest produces NO expectation file
  rather than a wrong one). The shell-safety convention is preserved: the tag
  is still consumed through the `RELEASE_TAG` env var (never `${{ }}`
  interpolated into script text); the assertion reads `$IMAGE_DIGEST` from the
  env. The file header records the single-line `sha256:<64hex>` contract and
  the double-prefix history.
- `test/publish-image-workflow.test.ts` (new): EXECUTES the real record
  step's `run:` block (extracted from the YAML, two-space-deindented) against
  a stub `gh` in a temp dir — a valid digest records exactly `sha256:<64hex>\n`;
  the old double-prefixed value fails closed (nonzero + `::error::`, no file
  written); the block keeps the verbatim write and the format assertion. This
  is stronger than a static string check, which a comment alone could satisfy.
- `package.json` `test:ci` now enumerates 27 suites by name (the new
  `publish-image-workflow` added to the unit set); `docs/CI.md` §7 updated
  (count + list + the dated note there) so the documented curated set matches
  the script.

**Other findings from the whole-workflow review (one fix + recorded items):**

- FIXED: the double-prefix (above) — the one concrete open-side defect.
- RECORDED (operator instruction; no code change): the `workflow_dispatch`
  trigger (line 23) has no `tag` input, so a manual dispatch uses
  `github.ref_name` and MUST be dispatched from the `v*` tag ref; dispatched
  from a branch it fails CLOSED at `gh release download` (a clear error, not a
  wrong record). Adding a `tag` input is an operator-surface decision, not a
  silent fix.
- RECORDED (consumer boundary): the release-note body APPENDS a
  `control-plane image digest:` block per run, while the release ASSET
  `image-digest.txt` is uploaded `--clobber` (always exactly one line).
  `verify-pin.sh` binds to the FIRST `sha256` line and its format note scopes
  "exactly one line" to the W149 release-asset format — so the ASSET is the
  authoritative machine record; a note-based consumer after a rerun would see
  multiple lines. Not reworked here (that would change the release-notes
  surface); the instance should materialize the asset.
- RECORDED (hardening, P3): the workflow pins actions by moving major tags
  (`actions/checkout@v4`, `docker/*@v6`, `docker/setup-buildx-action@v3`,
  `docker/login-action@v3`), not commit SHAs; a repo-wide supply-chain policy
  decision, out of scope for this fix.
- VERIFIED-OK (no change): the GHCR lowercase normalization (lines 37-39,
  `tr '[:upper:]' '[:lower:]'` before the push, correct for
  `ultus-net/Workflow`); the release-asset prerequisite fail-closed download +
  the explicit presence check (lines 41-53); the `sha256sum -c opencode.sha256`
  pin step (references the `opencode` asset name the download step writes,
  line 48 vs `images/control-plane/opencode.sha256`); the build context
  (`context: .` + repo-root-relative Dockerfile COPY paths — the review's P2
  from PR #132, already fixed). `instances/azure/verify-pin.sh` needs no
  change (its `grep -oE` tolerates the old doubled value; the contract it
  documents — one `sha256:<64hex>` line — is now what the workflow emits).

**Verification (local, this session):**

- `node --import tsx --test test/publish-image-workflow.test.ts` — 3/3 pass
  (the execution pins; red on the pre-fix `printf 'sha256:%s'` shape by
  construction).
- `npm run lint` exit 0 (unpiped); `npm run typecheck` exit 0 (unpiped).
- `shellcheck` (present): clean on the extracted record `run:` block and on
  `instances/azure/verify-pin.sh` exit 0. `actionlint` is ABSENT on this host
  (not installed; reported, not run).
- Five-axis review to be recorded by the wave's serialized review step.

**Honest status:** the workflow is corrected and structurally complete
(validated format + fail-closed assertion + regression pin wired into the
curated CI set). It remains **unverified live**: no GitHub run has executed
(`gh`/GHCR reachability and the actual build exist only in CI), and the
Dockerfile is unverified until a build. The live verification is the
operator's FIRST tagged run, and it requires the qualified opencode binary
attached to that tag's release as an asset (v2.0.10 is not publicly
fetchable). Recorded in `docs/PARKED_AND_LIMITATIONS.md` as L9.

**Refs:** issue #142; `docs/superpowers/specs/2026-09-26-deployment-instance-split.md`
§5/§10 Q2; PR #132 (the machinery's original landing).
