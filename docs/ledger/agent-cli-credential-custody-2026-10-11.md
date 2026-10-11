<!-- Ledger fragment: opened 2026-10-11 recording the agent CLI-credential custody slice (provider board PATs + the containment credential-reach pin). TASKS.md is frozen (post-freeze work tracks in the GitHub Project); write-once — append dated supersession notes, never rewrite. -->

### Agent credential custody: board provider PATs off the process environment + the containment credential-reach pin (2026-10-11)

**Source:** the operator's directive to tighten what contained agents can
reach, specifically not being comfortable with agents using logged-in CLI
tools (`gh`, `az`) unmonitored. This slice audits the reach and lands the
first durable fix.

#### Audit finding (measured, not assumed)

Every **contained** agent lane (opencode-server runtime, OpenCode ACP, Cline,
goose) launches through `buildBubblewrapInvocation` (`src/containment/bwrap-args.ts`)
with `--clearenv` (line 103) and `HOME` set to a hub-owned scratch dir
(`~/.workflow/acp-home`; `acp-runtime.ts:289/631`, `opencode-server-runtime.ts`).
`XDG_CONFIG_HOME` is likewise hub-owned. The boundary binds only `/etc`, `/usr`,
the Node prefix, and read-only `~/.local/bin` + `~/.npm`.

Consequence: the operator's `~/.config/gh`, `~/.azure`, `~/.aws`, `~/.docker`,
`~/.ssh`, `~/.git-credentials`, and `~/.netrc` are **not** reachable inside a
contained run, and `gh`/`az` are unauthenticated there (their config resolves
under the empty scratch HOME). The contained lanes are therefore already
credential-isolated from the host CLI. The residual reach is (a) the local
**ambient** hub lane (non-plane, the operator's own process by design —
`opencode-server.ts` `plane === undefined`), and (b) `network: host` in the
default egress posture (the recorded raw-socket residual, not a CLI leak).

#### What was done

1. **The hub's board reads no longer ride the process environment.** The board
   GitHub/Azure DevOps tokens were read straight from `WORKFLOW_GITHUB_TOKEN` /
   `WORKFLOW_AZURE_DEVOPS_TOKEN` (`task-provider.ts`, `azure-devops-provider.ts`)
   by the hub's board read closures. On the plane the hub and every agent tool
   process share one uid, so a PAT in the process environment is readable at
   `/proc/<pid>/environ` — the same uid-shared leak class as the C1 F2 upstream
   key. New seam `src/integrations/provider-token.ts`: when
   `WORKFLOW_BOARD_TOKEN_FROM=<backend>` is set, the configured `SecretStore`
   (Azure Key Vault in the deployed plane) is the **authoritative** source and
   the ambient token vars are scrubbed from the effective environment. Unset,
   the overlay is byte-identical (current behavior unchanged). `src/cli/hub.ts`
   resolves the effective board env once at startup and all five board read
   closures consume it. A set-but-unusable seam (unknown backend, or a store
   that cannot serve the secret) does **not** take down the hub: the board is a
   read-only projection and the hub is the mutation authority, so the failure is
   logged and the board reports an honest "unconfigured" state with the ambient
   tokens scrubbed — never a fallback to the uid-shared env. Scope is the hub's
   board reads; a future out-of-hub caller of `boardProviderFromEnv` would need
   to pass the same `boardEnv` to stay covered.

2. **Doctor exposure check for board tokens.** `checkBoardTokenExposure`
   (`src/cli/doctor.ts`) mirrors the F2 upstream-key check: presence-only, fails
   on the uid-shared plane, and never echoes the value.

3. **Containment credential-reach pin.** `test/containment-cli-credential-isolation.test.ts`
   pins `--clearenv`, the absence of any host CLI credential store in the
   boundary, and the scratch HOME — so a future change cannot silently re-grant
   an ambient credential store to a contained agent.

#### Honest status

- The provider-token seam is **enforced** when `WORKFLOW_BOARD_TOKEN_FROM` is
  set (fail-closed at parse; the store is authoritative). It is **inactive**
  until the operator stores the PATs (`workflow-github-token` /
  `workflow-azure-devops-token`) in the vault and sets the `_FROM` variable —
  the scoped operator setup is a separate, operator-run step.
- The contained-lane credential isolation is **existing behavior**, now pinned
  by a test rather than asserted in prose. No contained-lane code changed.
- Residual (unchanged, on record): the local ambient hub lane runs as the
  operator and reaches the host CLI by design; and `network: host` reaches host
  loopback/IMDS (SECURITY_ASSURANCE raw-socket residual). Neither is a
  contained-lane CLI-credential leak.
