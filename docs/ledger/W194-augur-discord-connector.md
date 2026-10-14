<!-- Write-once ledger fragment. Append dated supersession notes; never rewrite. -->
### W194 — augur's Discord surface: a thin, outbound-only connector

**Source:** augur Discord connector brief (M3b; branch
`feat/augur-discord-connector`). Discord is a dumb terminal: it forwards a
user's message to the assistant gateway (the M1 OpenAI-compatible endpoint,
W192) and renders the reply. The connector owns NO model logic and NO tools.

**Numbering note.** W185 (SHA-pin / tier-pin), W186 (kernel-purity gate), W188
(dependabot lane), W191 (kernel-purity lexer), W192 (assistant gateway), and
W193 are all taken. The Discord connector takes the next free number, W194.

**Decision.**
- **Identity = Discord snowflake.** The author's user snowflake is sent as the
  `x-workflow-user` header (`ASSISTANT_IDENTITY_HEADER`, imported — never
  hard-coded) so the gateway binds it to a route (`coding`|`tutor`|`care`). The
  gateway does all the model work; the connector is a renderer.
- **Outbound-only, metered egress.** `createDiscordGatewayClient` POSTs to
  `<gatewayUrl>/v1/chat/completions`. The front door (W193) enforces its client
  Basic credential BEFORE the assistant lane, so the connector presents the
  ingress credential (`AUGUR_GATEWAY_BASIC_AUTH`, `user:pass` or pre-encoded).
  The metered placeholder the egress proxy expects is set DOWNSTREAM by
  `handleAssistantRequest`, never by the connector; metering, egress policy, and
  credential injection apply unchanged and the connector holds no provider key.
- **Pure core, one adapter.** The allowlist, chunking, debouncer, draft-stream,
  and bridge are pure and tested with fakes. `discord.js` is confined to ONE
  file, `src/assistant/discord/connector.ts`, so the isolation gate
  (`discord.js` imported only here) holds and the library is removable.
- **Access is deny-wins.** `isAllowed` denies a listed id first (deny beats
  allow), treats an empty `allow` as open, and otherwise requires membership.
  A denied author never reaches the gateway.
- **Rendering.** Replies over Discord's 2000-char ceiling are split on line
  boundaries (`chunkMessage`), never mid-line unless a single line alone
  exceeds the limit. Rapid messages per channel coalesce through the
  `Debouncer`, and the `DraftStream` throttles progressive edits.

**Privileged intent.** The connector requests `Guilds | GuildMessages |
MessageContent`. Message Content is a privileged intent and must be enabled in
the Discord application settings, or the bot sees empty message bodies.

**Dependency.** `discord.js@^14.27.0` (Apache-2.0, `engines: node>=18`) is a
runtime dependency.

**Verification.**
- `node --import tsx --test test/assistant/discord/connector.test.ts` — 12
  tests: allowlist deny/open/membership/empty-id, chunking under the limit and
  the hard-split, the debouncer coalescing to the last run and cancellation, the
  draft-stream throttle, the disallowed author returning `undefined` without a
  gateway call, and the identity/placeholder headers + 500 error path against a
  fake HTTP server.
- `npx tsc -p tsconfig.json --noEmit`, `node --import tsx --test
  test/assistant-isolation.test.ts`, and `npx eslint src test` — clean.
