#!/usr/bin/env bash
# test-env-flag.sh — regression test for ensure_env_export() (install/lib/env-flag.sh).
#
# The predicate is what makes the watcher flag land in the live environment.d
# idempotently and without clobbering a user's edit, so it must be exactly as
# narrow as documented: append only when an uncommented `VAR=` is absent; a
# commented line or a deliberate `=false` override must not be overwritten; a
# second call must be a byte-for-byte no-op.
#
# Usage: bash install/lib/test-env-flag.sh   (exit 0 = pass)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/env-flag.sh"

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

fails=0
check() { # check <label> <expected-output> <file> <decl>
  local label="$1" want="$2" file="$3" decl="$4" got
  got="$(ensure_env_export "$file" "$decl")"
  if [[ "$got" == "$want" ]]; then
    printf '  ok   %s\n' "$label"
  else
    printf '  FAIL %s (wanted %q, got %q)\n' "$label" "$want" "$got"
    fails=$((fails + 1))
  fi
}

DECL='OPENCODE_EXPERIMENTAL_FILEWATCHER=true'

# 1. absent -> appended, and the file now carries the line.
f="$tmp/absent.conf"
printf 'EDITOR=nano\nPAGER=less\n' > "$f"
check "append when absent" "appended" "$f" "$DECL"
grep -q "^${DECL}$" "$f" || { printf '  FAIL line not written\n'; fails=$((fails + 1)); }

# 2. idempotent -> second call is present, no duplicate line.
check "idempotent second call" "present" "$f" "$DECL"
[[ "$(grep -c "^OPENCODE_EXPERIMENTAL_FILEWATCHER=" "$f")" == 1 ]] \
  || { printf '  FAIL duplicate line\n'; fails=$((fails + 1)); }

# 3. second call must not change bytes at all.
before="$(cat "$f")"
check "second call no-op" "present" "$f" "$DECL"
[[ "$before" == "$(cat "$f")" ]] || { printf '  FAIL file changed on no-op\n'; fails=$((fails + 1)); }

# 4. ADVERSE: a commented line is not a declaration -> append.
f="$tmp/commented.conf"
printf '# OPENCODE_EXPERIMENTAL_FILEWATCHER=true\n' > "$f"
check "commented line is not present" "appended" "$f" "$DECL"
[[ "$(grep -c "^OPENCODE_EXPERIMENTAL_FILEWATCHER=" "$f")" == 1 ]] \
  || { printf '  FAIL commented case did not append a real line\n'; fails=$((fails + 1)); }

# 5. ADVERSE: a deliberate override (any value) is respected -> no append.
f="$tmp/override.conf"
printf 'OPENCODE_EXPERIMENTAL_FILEWATCHER=false\n' > "$f"
check "explicit override not clobbered" "present" "$f" "$DECL"
grep -q '^OPENCODE_EXPERIMENTAL_FILEWATCHER=false$' "$f" \
  || { printf '  FAIL override was overwritten\n'; fails=$((fails + 1)); }

# 6. A different var must not match (anchoring check): prefix, suffix, export.
f="$tmp/prefix.conf"
printf 'X_OPENCODE_EXPERIMENTAL_FILEWATCHER=true\n' > "$f"
check "prefix token does not match" "appended" "$f" "$DECL"
[[ "$(grep -c '^OPENCODE_EXPERIMENTAL_FILEWATCHER=' "$f")" == 1 ]] \
  || { printf '  FAIL prefix case did not append a real line\n'; fails=$((fails + 1)); }
f="$tmp/suffix.conf"
printf 'OPENCODE_EXPERIMENTAL_FILEWATCHER_EXTRA=true\n' > "$f"
check "suffix token does not match" "appended" "$f" "$DECL"
[[ "$(grep -c '^OPENCODE_EXPERIMENTAL_FILEWATCHER=' "$f")" == 1 ]] \
  || { printf '  FAIL suffix case did not append a real line\n'; fails=$((fails + 1)); }
f="$tmp/export.conf"
printf 'export OPENCODE_EXPERIMENTAL_FILEWATCHER=true\n' > "$f"
check "export-prefixed spelling does not match" "appended" "$f" "$DECL"
[[ "$(grep -c '^OPENCODE_EXPERIMENTAL_FILEWATCHER=' "$f")" == 1 ]] \
  || { printf '  FAIL export case did not append a real line\n'; fails=$((fails + 1)); }

# 7. Missing file -> error, nothing created.
f="$tmp/does-not-exist.conf"
got=0; ensure_env_export "$f" "$DECL" >/dev/null || got=$?
if (( got == 1 )) && [[ ! -e "$f" ]]; then
  printf '  ok   missing file errors without creating\n'
else
  printf '  FAIL missing file (rc=%d, exists=%s)\n' "$got" "$([[ -e "$f" ]] && echo yes || echo no)"
  fails=$((fails + 1))
fi

# 8. ADVERSE: a read-only target must fail loud, not report success.
if [[ "$(id -u)" != 0 ]]; then
  f="$tmp/readonly.conf"
  printf 'EDITOR=nano\n' > "$f"
  chmod 400 "$f"
  got=0; out="$(ensure_env_export "$f" "$DECL" 2>/dev/null)" || got=$?
  if (( got == 1 )) && [[ "$out" != "appended" ]] && ! grep -q '^OPENCODE_EXPERIMENTAL_FILEWATCHER=' "$f"; then
    printf '  ok   read-only target fails loud (no false success)\n'
  else
    printf '  FAIL read-only target (rc=%d, out=%q)\n' "$got" "$out"
    fails=$((fails + 1))
  fi
  chmod 600 "$f"
else
  printf '  skip read-only target (running as root)\n'
fi

if (( fails > 0 )); then
  printf 'env-flag test — %d failure(s) — FAILED\n' "$fails"
  exit 1
fi
printf 'env-flag test — 10/10 pass — PASSED\n'
