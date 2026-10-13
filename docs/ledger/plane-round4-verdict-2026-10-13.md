# Round-4 in-plane verdict — the turn-abort fix held; two narrower defects recorded (2026-10-13)

Branch `docs/plane-round4-verdict`, base `6eb9cea2` (the `v0.1.13` merge).
Open-repo release **v0.1.13**, image
`sha256:744c38d91e0e2b6022fd60870e90a90b4a76fe33afb79b0018792628d6d19cc0`,
deployed as revision **`csh-dev-plane--0000020`** (Healthy, 100% traffic,
provisioned 2026-10-13T07:15:45Z) by the csh-dev pipeline run `20261013.5`.

This is the probe the round-3 posture note left PENDING: a rebuilt,
digest-repinned release running a real out-of-workspace tool call on a live
model turn.

## Result

**The headline round-3 defect is FIXED (live).** An out-of-workspace read
returned a non-fatal engine-native `external_directory` `permission.rejected`
and the SAME turn then created a `/workspace` file; 8+ repeated out-of-workspace
probes produced 0 `POLICY_CIRCUIT_BREAKER` / "repeated policy failures" entries.
No turn abort, no session freeze. The boundary no longer routes a broker `ask`.

Full item-by-item record: `docs/OPENCODE_SERVER_AUTHORITY.md`, round-4 addendum.

## Two new defects (recorded, neither blocks the boundary fix)

1. **Per-agent tier pins do NOT resolve on the v2 runtime — FALSIFIES the
   round-2 tier claim.** Verified: running each fleet agent records
   `model={id:"openrouter/auto",providerID:"openrouter"}` (the session default),
   not the `syn:small:text`/`syn:large:text` pin. Grounded in the pinned source:
   the v2 runner resolves the model from `session.model` only
   (`packages/core/src/session/runner/model.ts:188-206`); `CreateInput` carries
   `agent`/`model` as separate fields (`packages/core/src/session.ts:79-82`) and
   does not derive the model from the agent. The v1 path DOES fall back to
   `agent.model` (`packages/opencode/src/session/prompt.ts:469`), which is why
   the mechanism was assumed to carry over. Fix shape (not implemented): a
   plane-side session-create that seeds `model` from the selected agent, or a
   runtime mechanism mapping the v2 agent model into `session.model`.
2. **A broker `reject` still aborts siblings (narrower than round 3).** A
   non-boundary deny answered with `reject` (e.g. `subagent` denied `capability
   spawn is not available`) makes a sibling edit surface as
   `{"error":{"type":"aborted","message":"The user declined this tool call"}}`.
   Isolated probes: denied-`read`+edit succeeds; denied-`subagent`+edit is
   declined — the cascade is specific to the broker `reject` reply, not the
   engine-native boundary. Turn and session survive; one batch's siblings are
   lost.

## Residuals recorded, not fixed

- `/explain`'s write target (`~/.local/share/cheatsheets`) is outside
  `/workspace`, so a boundary-confined session cannot persist a sheet — a real
  skill/workspace-policy tension.
- `shell` (capability `process`) reads outside `/workspace` are not blocked; the
  external-directory deny is enforced on the `read`/`edit`/file-tool surface,
  not on arbitrary bash reads.

## Posture

The turn-abort / session-freeze claim moves from **Partial** to
**live-verified** on v0.1.13. The per-agent tier claim is marked **FALSIFIED for
the v2 plane lane**. The broker-reject sibling cascade is an **open follow-up**.
No new numbered `docs/SECURITY_ASSURANCE.md` residual: both new defects fail
toward denial/neutrality, not a security-boundary break (the count stays 27).

Verification: `node --import tsx --test test/security-assurance.test.ts` 9/9;
`docs/OPENCODE_SERVER_AUTHORITY.md`, `docs/FEATURES.md`, `THREAT_MODEL.md`
dated append-only notes.
