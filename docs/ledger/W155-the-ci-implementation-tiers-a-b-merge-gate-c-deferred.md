<!-- Ledger fragment: opened 2026-10-06 as a post-freeze W-item backfill (TASKS.md is frozen; live tracking is the GitHub Project). The full run-by-run record lives in docs/CI.md and issue #146; this file is the write-once per-item record. Append dated supersession notes, never rewrite. -->

### W155 - The CI implementation (tiers A+B merge gate, C deferred; the 35-run keyring provisioning saga) (Complete) (2026-09-26)

**Source:** GitHub issue #146 (closed 2026-09-26); design: `docs/CI.md` (tiers A/B/C/D); landed in PR #132 (merge `a0e1c42`, 2026-09-26).

**What landed:**

- **Tier A merge gate** (`.github/workflows/ci.yml`): lint, typecheck, build, `toolbox:verify` on every PR and main push.
- **Tier B PR evidence**: `npm run test:ci` (`package.json:57`), the named-suite enumeration (LESS-0051 contract e2e + unit suites; zero gated-probe or PTY suites). **Tier C** (full suite + live probes) is deferred to release gates by operator decision; **Tier D** publish is W149.
- **Runner environment**: bubblewrap installed (the Ubuntu 24.04 AppArmor unprivileged-userns relaxation is recorded as a `docs/CI.md` §8 residual); the keyring-gated W130 credential-custody e2e is provisioned through one `dbus-run-session` plus `gnome-keyring-daemon --unlock` — no cross-step env handoff, no `set +e`, and a canary failure fails the step loudly.
- **Two real product defects the runs surfaced**: the W097b foreign-home guard gap (`mcp-toolbox/apps/workflow-guard-mcp/src/path-policy.ts` — `/home` and `/root` as system-space prefixes with canonical-form home membership) and the root `postinstall` sitting outside `scripts` (the W137 dated correction).

**Evidence:** CI green on the merge head (run 36236280585, gate + evidence both success). No test was weakened — W130's fail-closed machine-gate is what carried the signal throughout. The run-by-run history (runs 1-35) is in `docs/CI.md` and issue #146.
