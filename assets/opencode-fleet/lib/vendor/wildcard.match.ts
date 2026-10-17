/**
 * wildcard.match.ts — VENDORED, DO NOT EDIT.
 *
 * The pure host glob matcher from opencode-src, copied verbatim so the
 * destructive-rule port's matcher mirror (`install/lib/wildcard-match.cjs`) is
 * diff-testable without the host checked out. Guarded by
 * `install/lib/test-wildcard-vendor.cjs`; re-vendor with
 * `install/lib/vendor-host-wildcard.cjs --src DIR --write`. The region between
 * the sentinels must stay byte-identical to the host slice.
 *
 *   repo:  opencode-src
 *   rev:   3dd1b3053979971d8eb03ef37b29de07b892d95c
 *   path:  packages/core/src/util/wildcard.ts
 *   file:  sha256 58803dad815e7086ad3e71746bb39fd63d48ab3041644cbd5f9a546c5617157c
 *   region: lines 3-14  sha256 e50c09ee80ef53478508b4642b23c00e95959b065be49a0c5ee97c30cd4e1d4f
 *   license: MIT (c) 2025 opencode — see LICENSE-opencode-src
 *
 * Node >=22 strips the TypeScript types at load time, so this is runnable as-is;
 * if type-stripping is unavailable the import throws, which the fixture catches.
 *
 * Vendored by `install/lib/vendor-host-wildcard.cjs`, mirrored as `install/lib/wildcard-match.cjs`.
 */

// >>> VENDORED REGION (verbatim)
export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}
// <<< VENDORED REGION
