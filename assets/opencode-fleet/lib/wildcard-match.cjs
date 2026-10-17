#!/usr/bin/env node
/**
 * wildcard-match.cjs — the host glob matcher, mirrored for the destructive-rule
 * port. Single home for the mirror previously inlined in
 * `test-port-destructive-rules.cjs`. The host resolves a permission rule's
 * resource as an anchored glob via `packages/core/src/util/wildcard.ts` match();
 * the port emits rules against that matcher, so this mirror must equal the host.
 * Equivalence is pinned by `install/lib/test-wildcard-vendor.cjs` against the
 * vendored host region (`install/lib/vendor/wildcard.match.ts`) — do not edit
 * `hostMatch` without re-running that suite.
 */

'use strict';

/**
 * Mirror of the host `match(input, pattern)` (non-win32 branch). Anchored,
 * case-sensitive, `*` -> `.*`, `?` -> `.`, and a trailing ` .*` becomes the
 * optional `( .*)?` so a bare tool name also matches its own rule.
 */
function hostMatch(input, pattern) {
  const normalized = input.replaceAll('\\', '/');
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?';
  return new RegExp('^' + escaped + '$', 's').test(normalized);
}

module.exports = { hostMatch };
