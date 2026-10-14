/**
 * Discord allowlist (pure). Design donor: `elizaos/plugin-discord` (MIT) — the
 * deny-wins / open-when-empty / membership-otherwise shape is modeled on it.
 * This is an independent implementation, not a copy.
 *
 * The connector is outbound-only and owns no model logic; the allowlist is the
 * single access-control decision it makes, kept pure so it can be tested with
 * fakes and reasoned about without a live Discord client.
 */

/** The allow/deny id sets (guild, channel, or user snowflakes). */
export interface DiscordAllowlist {
  /** Ids explicitly allowed. Empty means "open" (subject to `deny`). */
  readonly allow: readonly string[];
  /** Ids explicitly denied. `deny` always wins over `allow`. */
  readonly deny: readonly string[];
}

/**
 * Decide whether an id is allowed. Deny wins over allow; an empty `allow` list
 * is open (allow-all); otherwise the id must appear in `allow`. An empty id is
 * always denied.
 */
export function isAllowed(id: string, allowlist: DiscordAllowlist): boolean {
  if (id === "") return false;
  if (allowlist.deny.includes(id)) return false;
  if (allowlist.allow.length === 0) return true;
  return allowlist.allow.includes(id);
}
