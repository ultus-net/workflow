# common.sh — shared helpers for the install stages. Sourced by each stage.
# shellcheck shell=bash
# Contract: every stage is idempotent, safe to re-run, and never mutates the
# bootable system (rpm-ostree layering/rebasing is report-only; see 10-system).

# Repo root resolved from this file's location. BASH_SOURCE[1] is the stage
# script (install/<stage>.sh), so its dir + "/.." is the repo root.
# Dynamic source path — shellcheck cannot follow it.
# shellcheck disable=SC1091
_DOTFILES_ROOT="$(cd "$(dirname "${BASH_SOURCE[1]}")/.." && pwd)"

DRY_RUN="${DRY_RUN:-0}"

log()  { printf '[install] %s\n' "$*"; }
warn() { printf '[install] WARN: %s\n' "$*" >&2; }
die()  { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

# run <cmd...> — announce, then execute unless --dry-run.
run() {
  if (( DRY_RUN )); then
    log "dry-run: $*"
  else
    "$@"
  fi
}

# have <cmd> — true if the command exists on PATH.
have() { command -v "$1" >/dev/null 2>&1; }
