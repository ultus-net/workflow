<!-- Write-once ledger fragment. Append dated supersession notes; never rewrite. -->
### W181 — egress ledger auto-feed + posture-gated runtime-context teaching

**Source:** issue #441 (W181, NVIDIA adoption Wave A5/A6). The egress audit
(`docs/EGRESS_CAPABILITY_AUDIT.md` §7) listed the follow-ups: the metering proxy
should feed the advisory `egress-audit-mcp` ledger automatically, and the
runtime context should tell the agent what egress posture it is actually under.

**Decision.** PR #451 (`fa7e70cc`) lands both:
- **A5, the auto-feed.** The metering proxy emits a typed `EgressObservation` on
  every forwarded request (`reach`) and at the credential boundary (`reject`),
  carrying the bare destination hostname, a path-derived function class, and a
  closed token class — never a secret, placeholder value, path, or query string.
  `src/integrations/egress-audit-client.ts` maps each shape onto the ledger's
  `AppendReachInput` / `AppendRejectInput` and appends it over MCP (the
  `project-memory.ts` client pattern; `src/` does not import across the
  `mcp-toolbox/` package boundary). Rejections land in a separate `rejects`
  store with the refusing `policy` tag. The feed is **serialized, bounded, and
  fail-open** — an observation never breaks proxying, and the ledger is
  advisory/read-only evidence that never blocks.
- **A6, the runtime-context projection.** `src/integrations/runtime-context.ts`
  adds a presentation-only projection of the egress posture, **gated on the
  actual proxy posture** — it does not assert deny-by-default until that posture
  exists.

**Honest boundary.** The feed is **opt-in**: the OpenCode runtime composes
it behind `WORKFLOW_EGRESS_AUDIT_FEED=1` and only when the vendored ledger build
is present, so a production run needs the operator to set the flag. The Cline and
goose runtime sites are not wired (the issue scopes the OpenCode lane). The feed
observes what the proxy already decided; it is evidence, not a gate.

**Verification.**
- `node --import tsx --test test/egress-audit-client.test.ts` — the observation
  shapes, the bounded/fail-open feed, and the append/query reject tools.
- `node --import tsx --test test/runtime-context.test.ts` — the posture-gated
  projection.
- `mcp-toolbox/apps/egress-audit-mcp/test/egress-ledger.test.ts` and
  `test/mcp.test.ts` — the ledger's new append/query reject tools.
