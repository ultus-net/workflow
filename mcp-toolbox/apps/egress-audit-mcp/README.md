# egress-audit-mcp (W052)

Append-only, bounded, read-only **evidence** ledger of egress reaches: which
destination domain was reached, under which function class, and with which
token class, with anomaly flags. It is a first-party toolbox product built for
the capability-grant reframe in `docs/EGRESS_CAPABILITY_AUDIT.md`.

**Advisory evidence, never enforcement.** This server records and reports what
callers tell it. It cannot block a request, cannot change egress policy, and
cannot mutate Workflow state. Enforcement of token-bound egress lives in the
metering proxies (`src/integrations/model-usage-proxy.ts`); policy lives in
`workflow-guard-mcp` and the WorkflowApplication/hub integration. A clean
ledger means "no anomaly was reported", not "egress is safe".

## Tools

- `append_egress_reach` records one reach (`domain`, `functionClass`,
  `tokenClass`, optional `source`/`observedAt`). The ledger is append-only:
  records are never edited, rotated, or deleted. It is bounded (5000 entries /
  8 MB); when full, appends are **refused**, not pruned.
- `query_egress_reaches` reads recorded reaches, newest first, with optional
  `domain`, `functionClass`, `flaggedOnly`, and `since` filters, bounded by
  `limit` (max 200).
- `summarize_egress` returns entry count, top domains/function classes/token
  classes, and anomaly counts.

Every result's model-visible text is bounded (48k middle-cut parity) and the
server streams leveled MCP log notifications per tool call.

## Anomaly flags

Flags are computed against the ledger state at append time and stored
immutably, so they never change as later reaches arrive:

- `new-domain` — the domain had no prior reach in this ledger.
- `new-function-class-on-known-domain` — a function class not previously seen
  on a domain that already has entries. This is the capability-grant signal:
  a domain that was "known" gained a new reachable function.
- `non-session-token-observed` — the reach reported a `foreign` or `unknown`
  token class, i.e. a credential that is not the hub-provisioned session
  placeholder.

Token classes: `session-placeholder`, `absent`, `foreign`, `unknown`.
Function classes are a bounded free-form string; suggested values are exported
as `SUGGESTED_FUNCTION_CLASSES` (a genuinely new class is the point of the
flag, so the set is not closed).

## Trust boundaries

- **Input is untrusted report data.** A reach record is an assertion by its
  caller, not proof. The ledger's value is that appended history is
  immutable and bounded; it does not validate that a reach actually occurred.
- **No secret material is stored.** The token *class* is recorded, never a
  token value.
- **Coverage is whatever callers feed it.** Nothing in this product observes
  the network; it only records reaches reported to it. Today the ledger is fed
  by explicit `append_egress_reach` calls; wiring proxy rejections/reaches in
  automatically is a recorded follow-up in the audit doc.
- **The store assumes a private data directory** (`0700` dir, `0600` file,
  atomic rename). A local user with write access can append or replace bytes;
  the ledger is not an authenticated log.
- **Not a boundary for direct egress.** A `network=host`-class path that
  bypasses the proxies is invisible here — detection is only where a proxy (or
  another reporter) is interposed. See `docs/EGRESS_CAPABILITY_AUDIT.md` §5.

## Configuration

- `EGRESS_AUDIT_DATA_DIR` — ledger directory (default
  `XDG_DATA_HOME/egress-audit-mcp` or `~/.local/share/egress-audit-mcp`).

## Development

Requires Node.js 22+.

```sh
pnpm run verify
```