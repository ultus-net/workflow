/**
 * W183: generation-bound hub tokens.
 *
 * A hub mints one random `generation` at start; every token it issues is
 * `<generation>.<secret>`. `verifier.json` / `discovery.json` carry the
 * generation. Authorization (`authorizeHubToken`) requires BOTH the token's
 * generation segment to equal the live hub's AND constant-time equality with
 * the expected token, so a token replayed from a previous hub start is
 * rejected by the explicit generation binding, not merely because the secret
 * happens to differ. That makes the generation a first-class token component:
 * a future change that derived a stable secret would still fail across
 * restarts.
 *
 * Honest scope (do not overclaim): this closes **replay across restarts** only.
 * A same-UID process that can read the current `verifier.json` /
 * `discovery.json` still holds a live token — `THREAT_MODEL.md` W073 item 1
 * (the same-UID file-read residual) stays recorded and is not closed by this
 * binding. Only OS-level containment of `~/.workflow/hub/` closes it.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

export interface HubToken {
  readonly token: string;
  readonly generation: string;
}

/** A fresh random generation identifier. */
export function mintHubGeneration(): string {
  return randomBytes(8).toString("hex");
}

/** Mints `<generation>.<32-byte-secret>` for a generation. */
export function mintHubToken(generation: string = mintHubGeneration()): HubToken {
  return { token: `${generation}.${randomBytes(32).toString("hex")}`, generation };
}

/** The generation segment of a token, or undefined for a malformed token. */
export function tokenGeneration(token: string): string | undefined {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return undefined;
  const generation = token.slice(0, dot);
  if (!/^[0-9a-f]+$/.test(generation)) return undefined;
  return generation;
}

/**
 * True when `token` carries the live hub's generation. A malformed token, or
 * one minted by another instance, is rejected. This is the explicit binding
 * check; the bridge composes it with constant-time full-token equality.
 */
export function tokenMatchesGeneration(token: string, generation: string): boolean {
  return tokenGeneration(token) === generation;
}

/**
 * W183: authoritative token check at the hub authorization boundary. A token
 * is accepted only when (a) its generation segment is the live hub's — the
 * explicit binding, so a future change that derived a stable secret still
 * fails across restarts — and (b) it equals the expected token under constant
 * time. Both must hold; the generation segment alone is never sufficient, and
 * the digest equality alone would silently degrade to plain secret rotation.
 */
export function authorizeHubToken(supplied: string, expected: string, generation: string): boolean {
  if (!tokenMatchesGeneration(supplied, generation)) return false;
  const actual = Buffer.from(supplied);
  const want = Buffer.from(expected);
  return actual.length === want.length && timingSafeEqual(actual, want);
}
