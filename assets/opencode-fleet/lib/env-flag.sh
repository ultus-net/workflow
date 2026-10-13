# env-flag.sh — the append-if-missing predicate for a live environment.d line,
# kept sourceable so install/lib/test-env-flag.sh can exercise it without
# running a stage. Predicate in lib, fixtures in a sibling test wired into
# .githooks/pre-commit.
# shellcheck shell=bash

# env_flag_present <file> <varname> — true (exit 0) if an uncommented
# `VAR=...` assignment exists. Anchored, so a commented `# VAR=...` or a `VAR`
# token inside another line does not count. ANY value counts (including an
# explicit `=false`), so a user's deliberate override is never clobbered.
env_flag_present() {
  local file="$1" var="$2"
  grep -q "^${var}=" -- "$file"
}

# ensure_env_export <file> <decl> — idempotently append the assignment line
# `decl` (e.g. `VAR=true`) to `file` when absent, else leave it untouched.
# Echoes exactly one of `present` / `appended`. A missing file is an error (the
# caller seeds it first). A leading blank line separates the new block from
# existing content; a second call is a no-op, so the file stays stable.
ensure_env_export() {
  local file="$1" decl="$2"
  local var="${decl%%=*}"
  if [[ ! -f "$file" ]]; then
    printf 'env-flag: no such file: %s\n' "$file" >&2
    return 1
  fi
  if env_flag_present "$file" "$var"; then
    printf 'present\n'
    return 0
  fi
  if ! printf '\n%s\n' "$decl" >> "$file"; then
    printf 'env-flag: failed to write %s\n' "$file" >&2
    return 1
  fi
  printf 'appended\n'
}
