import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizeHubToken, mintHubGeneration, mintHubToken, tokenGeneration, tokenMatchesGeneration } from "../src/integrations/hub-tokens.js";

/**
 * W183: generation-bound hub tokens. These pin the binding: a token carries
 * the hub-start generation, and a token from another generation is rejected.
 *
 * The same-UID file-read residual (THREAT_MODEL W073 item 1) is NOT tested
 * here — it stays recorded, not closed.
 */

test("W183: minted hub tokens carry the generation they were minted for", () => {
  const generation = mintHubGeneration();
  const token = mintHubToken(generation);
  assert.equal(token.generation, generation);
  assert.equal(tokenGeneration(token.token), generation);
  assert.equal(tokenMatchesGeneration(token.token, generation), true);
});

test("W183: two generations mint different token prefixes", () => {
  const first = mintHubToken();
  const second = mintHubToken();
  assert.notEqual(first.generation, second.generation);
  assert.notEqual(tokenGeneration(first.token), tokenGeneration(second.token));
  assert.equal(tokenMatchesGeneration(first.token, second.generation), false);
  assert.equal(tokenMatchesGeneration(second.token, first.generation), false);
});

test("W183: a malformed token has no generation and never matches", () => {
  for (const malformed of ["", "no-dot", ".onlysecret", "gen.", "GEN.secret", "a b.c"]) {
    assert.equal(tokenGeneration(malformed), undefined, `expected no generation for ${JSON.stringify(malformed)}`);
    assert.equal(tokenMatchesGeneration(malformed, "deadbeef"), false);
  }
});

test("W183: authorization requires the live generation, not just a matching secret", () => {
  const live = mintHubToken("aabbccdd");
  // Exact token: accepted.
  assert.equal(authorizeHubToken(live.token, live.token, "aabbccdd"), true);
  // Same secret body, WRONG generation prefix: rejected on the binding even
  // though a digest comparison of the secret alone would pass. This is the
  // property that makes the generation authoritative rather than incidental.
  const wrongPrefix = `00112233.${live.token.split(".")[1]}`;
  assert.equal(authorizeHubToken(wrongPrefix, live.token, "aabbccdd"), false);
  // Correct generation prefix, wrong secret: rejected on constant-time equality.
  assert.equal(authorizeHubToken(`aabbccdd.${"0".repeat(64)}`, live.token, "aabbccdd"), false);
  // A token minted by another generation: rejected.
  const other = mintHubToken("ffeeddcc");
  assert.equal(authorizeHubToken(other.token, live.token, "aabbccdd"), false);
});
