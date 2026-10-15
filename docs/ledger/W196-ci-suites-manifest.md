# W196 — the Tier-B CI suite manifest (kills the recurring `test:ci` conflict)

Date: 2026-10-15. Status: implemented. Branch: `fix/ci-suites-manifest`.

## Why

`package.json` `test:ci` enumerated the 65-suite Tier-B set on **one
1943-character line**. Every PR that adds a test edits that identical line, so
any two test-adding PRs conflicted on merge, every time. Observed live in the
same wave: PR #560 (`test/hub-assistant-routes.test.ts`) and PR #561
(`test/assistant/provider-endpoint.test.ts`) both conflicted with `main` on
that line, and each needed a rebase to land.

## The defect this also repaired (introduced during those rebases)

The hand-written conflict resolution re-prepended the command prefix instead of
only appending the new path. `origin/main` at `3fb8179d` carried:

```
node --import tsx --test node --import tsx --test node --import tsx --test test/e2e-admin.test.ts ...
```

The prefix was triplicated (one per rebase). The stray tokens did **not** drop
any suite (the union of curated files across the wave equals the head set, 65 =
65) and node tolerated the extra `node` token (local probe: 9/9 pass, exit 0;
CI run `38706711111` at `14648dea` was green), so the corruption was cosmetic
in effect — but it was wrong and would have multiplied with each future
append-on-conflict. This change removes it.

## The fix

The enumeration moves out of the JSON string into a **sorted manifest**:
`test/ci-suites.txt` (one path per line, blank lines and `#`-comments ignored),
run by `scripts/run-ci-suites.mjs`. `test:ci` becomes
`node scripts/run-ci-suites.mjs`.

Why sorted: two concurrent suite additions land on **different** manifest
lines, so git merges them without a conflict. That is the property the
single-line script could never have — any two edits touched the same line.

The naming enumeration guarantee is unchanged (`docs/CI.md` section 4): the
runner passes `node --import tsx --test <explicit paths>`, never a glob. A glob
would silently admit a PTY/agent/hub-spawning suite on the first new `test/`
file.

The runner fails closed if the manifest names a file that does not exist,
rather than letting node surface it mid-run.

## The pins

`test/ci-suites-manifest.test.ts` (listed in the manifest itself, so CI runs
it) asserts:

- the manifest is **sorted** — the property that avoids the merge conflict;
- entries are **unique**;
- every entry **exists** and is a `test/*.test.ts` path;
- the manifest **lists this test** (self-enforcing);
- `test:ci` routes through the runner and carries **no glob**.

## Verification

- `npx tsc -p tsconfig.json --noEmit` — 0.
- `npx eslint src test` — 0.
- `test/ci-suites-manifest.test.ts` — 5/5 pass.
- `node scripts/run-ci-suites.mjs` end-to-end — 538 tests, 528 pass, 10 fail.
  All 10 are **environment failures reproduced on pristine `origin/main`**,
  not regressions:
  - 8× compiled-hub / contained-shell e2e fail on this Fedora host with
    `bwrap: Can't mount on symlink destination /bin/sh` (`/bin/sh -> bash`);
    the CI runner is `ubuntu-latest`, where `/bin/sh -> dash` and the shell is
    not a symlink, so the mount succeeds.
  - `security-assurance`'s FEATURES.md toolbox-count pin fails 1/1 on a
    pristine `origin/main` worktree too (`docs/FEATURES.md` advertises 14, the
    vendored corpus has 17) — pre-existing, unrelated to this change.
- No suite was dropped: manifest set (65 original paths) equals the pre-wave
  `eadec11a` set plus the three added by #559/#560/#561.
