#!/usr/bin/env bash
# DRAFT (W147 seed, refined 2026-09-26; the open-side half is W149):
# fail-closed image-digest pin verification for the deployment instance.
#
# Runs in the instance pipeline BEFORE any deploy step. Exits nonzero on a
# missing expectation, a missing actual digest, or any mismatch — a broken or
# absent check never degrades to deploy-anyway.
#
# Contract:
#   argv[1] = path to the digest-expectation record shipped with the pinned
#             open release (release asset or note materialized at checkout)
#   argv[2] = the full image reference the pipeline intends to deploy
#             (registry/repo@sha256:<64 hex>)
#   exit 0  = the digest portion matches byte-for-byte
#   exit 1  = missing expectation, missing actual, malformed either, mismatch

set -euo pipefail

expected_file="${1:-}"
actual="${2:-}"

[ -n "$expected_file" ] || { echo "verify-pin: no expectation record given" >&2; exit 1; }
[ -n "$actual" ] || { echo "verify-pin: no image reference given" >&2; exit 1; }
[ -f "$expected_file" ] || { echo "verify-pin: expectation record not found: $expected_file" >&2; exit 1; }

expected="$(grep -oE 'sha256:[0-9a-f]{64}' "$expected_file" | head -1 || true)"
[ -n "$expected" ] || { echo "verify-pin: no sha256 expectation in $expected_file" >&2; exit 1; }

case "$actual" in
  *"@${expected}")
    echo "verify-pin: pin verified (${expected})"
    exit 0
    ;;
  *)
    echo "verify-pin: MISMATCH — expectation ${expected}, intended ${actual}" >&2
    exit 1
    ;;
esac