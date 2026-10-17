#!/usr/bin/env bash
# test-hook-worktree-guard.sh — regression test for the pre-commit guard that
# drops the repo-locating env vars git exports to a hook run from a LINKED
# worktree (GIT_DIR et al.).
#
# Why this test exists (n=42): in a linked worktree git exports GIT_DIR and
# GIT_INDEX_FILE to the hook. `GIT_DIR` overrides `git -C <dir>`, so the hook's
# nested-git fixture suites (Layer 4 test-validate-agents-actions, Layer 14
# test-index-read, Layer 15 test-validate-ledger) had their fixture `git init` /
# `git config user.*` / `git commit` land in the REAL repo: `core.bare` flipped
# to true and `[user] name/email` was overwritten with the fixture's `t / t@t`.
# That is a self-inflicted repo corruption triggered by an ordinary
# `git commit` from a worktree.
#
# Teeth: this test reads the guard OUT of the real hook. If the guard is deleted
# from the hook, the "guarded" trial below becomes unguarded and the real-repo
# assertions fail. A negative control proves the corruption is real (an
# unguarded hook does clobber the real repo), so the test cannot pass vacuously.
#
# Usage: bash install/lib/test-hook-worktree-guard.sh   (exit 0 = pass)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/../../.githooks/pre-commit"

# This test runs its own scratch repos; do not let this shell's own git calls be
# hijacked if the test itself is launched from a linked worktree.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR \
      GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX

fails=0
ok()  { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }

if [[ ! -f "$HOOK" ]]; then
  printf '  FAIL hook not found: %s\n' "$HOOK" >&2
  exit 1
fi

# The guard, extracted verbatim from the real hook (so this test has teeth: it
# exercises the hook's OWN guard, not a copy that can drift). The guard is one
# logical line continued with backslashes, so capture until a line with no
# trailing backslash.
GUARD="$(awk '/^unset GIT_DIR /{p=1} p{print} p && $0 !~ /\\$/{exit}' "$HOOK")"
if [[ -z "$GUARD" || "$GUARD" != *GIT_DIR* ]]; then
  bad "the hook carries no 'unset GIT_DIR ...' worktree-safety guard (removed?)"
fi

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

# Build a scratch repo whose hook (guarded or not) commits into its OWN temp
# dir — the shape the hook's real suites use (`git -C <tmp> init/config/commit`).
# Commit from a LINKED worktree, then echo "<bare>|<email>|<seen>".
trial() { # trial <guarded|unguarded>
  local mode="$1"
  local base="$tmp/$mode"
  local main="$base/main" hooks="$base/hooks" seen="$base/seen.txt"
  mkdir -p "$main" "$hooks"
  git -C "$main" init -q -b main
  git -C "$main" config user.email real@example.com
  git -C "$main" config user.name Real
  echo base > "$main/f.txt"
  git -C "$main" add f.txt
  git -C "$main" commit -qm base
  git -C "$main" config core.hooksPath "$hooks"   # absolute: shared by the worktree

  {
    echo '#!/usr/bin/env bash'
    echo 'set -u'
    [[ "$mode" == guarded ]] && printf '%s\n' "$GUARD"
    # Prove the guard does not blind the hook's own index read.
    printf 'echo "SEEN=[$(git diff --cached --name-only | tr "\\n" " ")]" >> %q\n' "$seen"
    # Break any hook recursion: the fixture commit below sets FHG_NO_FIXTURE=1 in
    # its own environment, so if the fixture leaks into THIS repo (the corruption
    # under test), the recursively-invoked hook exits before running the fixture
    # again. This keeps the negative control from hanging without masking the
    # leak (the config clobber and core.bare flip still happen).
    echo '[ "${FHG_NO_FIXTURE:-0}" = 1 ] && exit 0'
    cat <<'BODY'
TMPFIX=$(mktemp -d)
git -C "$TMPFIX" init -q
git -C "$TMPFIX" config user.email t@t
git -C "$TMPFIX" config user.name t
echo base > "$TMPFIX/README.md"
git -C "$TMPFIX" add README.md
FHG_NO_FIXTURE=1 git -C "$TMPFIX" commit -qm fixture-base
rm -rf "$TMPFIX"
exit 0
BODY
  } > "$hooks/pre-commit"
  chmod +x "$hooks/pre-commit"

  git -C "$main" worktree add -q "$base/wt" -b wtbranch
  echo hi > "$base/wt/g.txt"
  git -C "$base/wt" add g.txt
  timeout 60 git -C "$base/wt" commit -qm "from linked wt" >/dev/null 2>&1

  local bare email seenval
  bare="$(git -C "$main" config --get core.bare || echo unset)"
  email="$(git -C "$main" config --get user.email || echo unset)"
  seenval="$(tail -1 "$seen" 2>/dev/null || echo '(none)')"
  printf '%s|%s|%s\n' "$bare" "$email" "$seenval"
}

# 1. POSITIVE: with the guard, the real repo keeps its identity, and the hook
#    still sees the staged file (the guard does not blind the scanner).
res="$(trial guarded)"
bare="${res%%|*}"; rest="${res#*|}"; email="${rest%%|*}"; seen="${rest#*|}"
if [[ "$bare" == "false" && "$email" == "real@example.com" ]]; then
  ok "guarded hook: real repo core.bare stays false, user.email untouched"
else
  bad "guarded hook leaked into the real repo (core.bare=$bare, user.email=$email)"
fi
if [[ "$seen" == *g.txt* ]]; then
  ok "guarded hook: the scanner still reads the staged index ($seen)"
else
  bad "guarded hook did not see the staged file (seen=$seen)"
fi

# 2. NEGATIVE CONTROL: without the guard the same fixture clobbers the real repo.
#    This proves the corruption is real and the guard is load-bearing, so test 1
#    cannot pass vacuously.
res="$(trial unguarded)"
bare="${res%%|*}"; rest="${res#*|}"; email="${rest%%|*}"
if [[ "$bare" == "true" || "$email" != "real@example.com" ]]; then
  ok "unguarded hook corrupts the real repo (core.bare=$bare, user.email=$email) — the guard is load-bearing"
else
  bad "negative control did not reproduce corruption (core.bare=$bare, user.email=$email)"
fi

if (( fails > 0 )); then
  printf 'hook worktree-guard test — %d failure(s) — FAILED\n' "$fails"
  exit 1
fi
printf 'hook worktree-guard test — 3/3 pass — PASSED\n'
