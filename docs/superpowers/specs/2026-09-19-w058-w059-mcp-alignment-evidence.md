# W058 / W059 evidence — MCP 2026-07-28 alignment and Server Cards

**Date:** 2026-09-19. **Branch:** `w058-mcp-2026-07-28` (worktree `w058-mcp-align`), based on `main` @ `05a7d3c`.
**Scope:** `docs/superpowers/plans/2026-09-19-ai-landscape-followups.md` W058 (MCP 2026-07-28 alignment) then W059 (Server Cards + progressive discovery metadata), which builds on W058.
**Honest-claims posture:** every claim below is either an inspected SDK fact or a reproducible command result. Features the vendored SDK does not implement are recorded as gaps, not hand-rolled. No surface's advisory/enforced status changes. No `TASKS.md` edits were made (the plan is still DRAFT; these tasks are not promoted).

---

## 1. SDK survey (W058 slice 1)

**Vendored SDK:** `@modelcontextprotocol/sdk@1.30.0` (the lockfile-resolved version; the workspace range is `^1.30.0` and the toolbox root `package.json` pins `^1.30.0`). `1.30.0` is the current published latest (`npm view @modelcontextprotocol/sdk dist-tags` → `latest: 1.30.0`), so **no upgrade was needed or possible**; the survey is of the newest generation.

The machine-readable source of truth is `mcp-toolbox/packages/protocol-baseline/src/spec.ts` (`FEATURE_SURVEY`), asserted by `spec.test.ts`.

| 2026-07-28 feature | SDK 1.30.0 | Evidence | Toolbox disposition |
|---|---|---|---|
| Stateless core (SEP-2575/2567) | **native** | `StreamableHTTPServerTransport` supports `sessionIdGenerator: undefined`; `examples/server/simpleStatelessStreamableHttp.js` | Already stateless by construction (stdio, no connection-local catalog); asserted by `stateless_catalog_stable` |
| `server/discover` | **absent** | No request schema or `server/discover` literal anywhere in `dist/` | **Not adopted** — would be a hand-rolled protocol layer; capability payload lives in the Server Card and `initialize` |
| TTL-cacheable lists (SEP-2549) | **absent** | `ListToolsResultSchema`/`ListResourcesResultSchema`/`ListPromptsResultSchema` have no `ttl`; `McpServer`'s `ListTools` handler returns only `{ tools }` | **Not adopted** — not expressible in this SDK; host-side definition caching remains the documented alternative |
| Tasks extension (SEP-2663) | **native** | `experimental/tasks`: `ToolTaskHandler`, `TaskStore`, `InMemoryTaskStore`, `server.experimental.tasks.registerToolTask`, `tasks/get|list|cancel`, `notifications/tasks/status` | **Adopted** for `run_verification_async` in `verification-accountability-mcp` |
| MRTR (SEP-2322) | **partial** | Elicitation + task `input_required` exist; no SEP-2322 envelope | **Not adopted / not-applicable** — no elicitation-style multi-turn flow exists in the toolbox |
| One tool-result contract | **native** | SDK convention: `outputSchema` ⇒ `structuredContent`; `CallToolResultSchema.content` is a `ZodDefault` and may be omitted; `validateToolOutput` requires `structuredContent` when `outputSchema` is declared | **Adopted as a declared contract** (every tool declares one result shape; `structuredContent` canonical) — see §5 |
| CIMD registration | **partial** | `shared/auth` exposes `client_id_metadata_document_supported` | **Advertised-readiness / deferred** — no HTTP/OAuth transport in the toolbox; see §6 |
| Enterprise-Managed Authorization (ID-JAG) | **absent** | No ID-JAG types/flow in `dist/` | **Deferred, dated** — see §6 |
| Server Cards (`.well-known`) | **absent** | No card schema/helper in the SDK | **Adopted first-party** (W059) |

**Confirmed gaps recorded, not worked around:** `server/discover`, TTL list caching, full MRTR, and ID-JAG are not in SDK 1.30.0. The W058 acceptance criterion that names "discover" as part of the conformance smoke cannot be met by the SDK; the smoke instead asserts stateless catalog stability and the Task/result-contract features, and this note records the discover gap explicitly.

---

## 2. Conformance smoke (W058 AC 1)

`mcp-toolbox/packages/protocol-baseline/src/conformance.ts` runs against the compiled `dist/server.js` of every product over the real MCP stdio boundary. Wired into `pnpm run verify` through the package's test suite (`conformance.test.ts`).

Command and result:

```
$ pnpm --dir mcp-toolbox run verify      # typecheck + build + all package tests
pnpm_verify_exit=0

$ pnpm --dir mcp-toolbox run protocol:conformance
14/14 apps passed; SDK survey 2026-09-19: 3 native, 2 partial, 4 absent
```

Checks per product: `catalog_nonempty`, `tool_result_contract`, `stateless_catalog_stable` (two independent processes advertise identical definitions), `server_card` (valid, schema-validated), and for `verification-accountability-mcp` additionally `tasks_extension` (`taskSupport=required`) and `tasks_capability` (tasks capability declared).

---

## 3. Tasks extension (W058 AC 2)

`verification-accountability-mcp` now ships `run_verification_async`, registered with `server.experimental.tasks.registerToolTask(..., { execution: { taskSupport: "required" } })`:

- Declares the `tasks` server capability (`requests.tools.call`, `list`, `cancel`) and an `InMemoryTaskStore`.
- The bounded authority-backed observation is obtained out-of-band; the result is stored via `taskStore.storeTaskResult`.
- Progress/log visibility uses the existing leveled-log convention (`notifications/message`, phase `start`/`done`/`error`, tagged with `taskId`); status is observable through `tasks/get` and `notifications/tasks/status`.
- Cancellation follows the request `AbortSignal` passed to `recordVerification`.

Verification evidence (`apps/verification-accountability-mcp/test/mcp.test.ts`):

```
$ node --test --import tsx test/*.test.ts
# tests 13
# pass 13
# fail 0
```

The new test drives `client.experimental.tasks.callToolStream`, asserts a `taskCreated` message, a terminal `completed` status via `tasks/get`, and the stored observation (`failed === 1`) from the task result. The pre-existing catalog test now also pins `execution.taskSupport === "required"`.

**Hub-monitoring probe honesty:** the acceptance criterion asks for an env-gated live hub probe with a recorded verdict. That probe was **not** run (no hub/MCP-client task consumer is wired in this worktree; the hub-as-MCP-client path is stdio today). What is proven is the protocol-level Tasks flow at the stdio boundary; the hub-monitoring verdict remains open and is recorded here rather than claimed.

---

## 4. Token-economy delta (W058 AC 3; W059 AC 2)

Measured at the MCP boundary by `protocol:measure` (launch each compiled product, take `tools/list`, count UTF-8 bytes). "Before" = the full catalog an eager host injects at session start. "After" = the compact Server-Card tool index (names, descriptions, risk hints; no schemas).

```
$ pnpm --dir mcp-toolbox run protocol:measure
app                               tools  catalog  in-schema  out-schema  index  savings
change-intelligence-mcp               1     5925        826        4633    324    94.5%
ci-intelligence-mcp                   2     2681        570        1541    344    87.2%
code-intelligence-mcp                 5     6032       1710        3045    832    86.2%
continuity-checkpoint-mcp             1     1496        446         558    373    75.1%
git-intelligence-mcp                  4     4923       1219        2621    637    87.1%
learning-mcp                          5    10159       3021        5074   1506    85.2%
project-context-mcp                   1     1271        280         561    311    75.5%
project-memory-mcp                    2     4051        870        2356    596    85.3%
review-accountability-mcp             3    10380       2991        6205    845    91.9%
skills-mcp                            2     1899        257         855    511    73.1%
test-intelligence-mcp                 3     3898        949        2095    538    86.2%
verification-accountability-mcp       3    12578       2648        8545   1048    91.7%
workflow-fs-exec-mcp                  3     2326        818         527    572    75.4%
workflow-guard-mcp                    2     1600        635         268    613    61.7%
TOTAL                                37    69219      17240       38884   9050    86.9%
```

Portfolio: **69,219 bytes full catalog → 9,050 bytes progressive index = 86.9% reduction** (60,169 bytes saved) at session start, with the full definitions still available through the standard `tools/list` on demand. This is exact serialized bytes, the host-neutral secondary metric from the accepted P702A decision — not a `bytes/4` token guess.

Note the portfolio has grown since the 2026-08-29 P702A baseline (19 tools / 27,955 bytes): it is now 37 tools / 69,219 bytes (the added task tool plus products landed since). The 2% initial-context ceiling cited by P702A is a deployment-time decision that still depends on the host's eager/progressive behavior; `verification-accountability-mcp` alone is now 12,578 bytes eager.

---

## 5. Tool-result contract (W058 AC 5)

Declared contract (`protocol-baseline/src/tool-result.ts`, enforced by `tool_result_contract` in the smoke):

- Every tool declares exactly one result shape: an `outputSchema` (`structuredContent` canonical), or membership in a documented content-only allowlist. Today the only allowlist entries are `workflow-guard-mcp`'s `guard_check`/`guard_status`.
- The SDK already resolves "which form does the client show": `outputSchema` ⇒ `structuredContent`; otherwise `content`. The 2026-07-28 "the server can't know which form the client shows" hazard is therefore closed at declaration time.
- Policy constant `RESULT_SHAPE_POLICY` marks the **duplicate bounded text companion** as deprecated-once-hosts-surface-structured-output.

**Honest partial:** the physical removal of the duplicate text is **deferred**. `packages/result-bounds` deliberately bounds only the `text` content and keeps `structuredContent` exact, because it assumes structured-output-capable hosts read structure. Removing the bounded text today would make eager hosts fall back to unbounded `structuredContent` and regress the accepted P702A token economy. This interaction is the open question for the contract's deprecation step.

---

## 6. Authorization baselines (W058 AC 4)

- **CIMD:** the vendored SDK can advertise `client_id_metadata_document_supported`, but every toolbox product is a **stdio** server with no HTTP/OAuth registration path. Disposition: **advertised-readiness only, no live adoption claimed.** When a toolbox product gains an HTTP transport, CIMD is the preferred client-registration path per the 2026-07-28 baseline.
- **Enterprise-Managed Authorization (ID-JAG): DECISION — DEFER (2026-09-19).** SDK 1.30.0 ships no ID-JAG/EMA types, and the toolbox has no enterprise identity consumer. Implementing it now would mean hand-rolling both the protocol and a federation trust anchor outside Workflow's authority model. Ownership of the longer-term identity work is **W060** (agent identity: DPoP-bound revocable session tokens, Workload Identity Federation/ID-JAG/WIMSE watch items). No federation is implemented here, and no claim beyond "deferred" is made.

---

## 7. Server Cards (W059 AC 1, AC 3)

`protocol-baseline/src/cards.ts` generates `apps/<product>/.well-known/server-card.json` from exactly two sources: the product's `package.json` and its compiled `tools/list` (captured through the MCP boundary). There is **no hand-maintained tool list**. The card carries schema/version/description, protocol version `2026-07-28`, transport, capabilities, the compact tool index, and the measured `fullCatalogBytes`/`toolIndexBytes`.

- Generator: `pnpm --dir mcp-toolbox run cards:generate` (14 cards written).
- Validation + drift: `cards.test.ts` (in `pnpm run verify`) parses every committed card with a Zod schema, asserts it matches the live compiled catalog, and fails when a card is missing or stale (`check-cards`).
- Packaging: `.well-known/` was added to each product's `files` array so the card travels with the npm artifact.

Note: the Server Card WG's `.well-known` layout is not in SDK 1.30.0, so the schema URL/fields are a first-party convention documented as such; the AC's "serve a valid card" is interpreted as "the generated artifact is shipped in each product and validated in `verify`", since stdio products cannot serve HTTP `.well-known` routes.

---

## 8. Progressive discovery — and a recorded architecture conflict (W059 AC 2)

**Conflict found:** W059's plan slice says "each server exposes a minimal entry tool plus catalog-expansion flow", i.e. a server-side dynamic catalog. The repo's **accepted** decision `mcp-toolbox/docs/architecture/tool-exposure-context-economics.md` (2026-08-29) and TODO `P702A` say the opposite:

> "MCP servers continue to publish complete, stable, interoperable capabilities. Progressive disclosure belongs to the host/provider boundary… Servers must not implement connection-local or model-use-dependent tool catalogs to simulate lazy loading."

Per the repo's rule that reality/accepted docs win over a DRAFT plan, this implementation does **not** mutate `tools/list` per connection. Instead progressive discovery is delivered as **host-facing metadata**: the Server Card's compact tool index is the minimal entry surface, and the complete definitions remain available through the standard `tools/list` on demand. The measured **86.9% index-vs-catalog delta** (§4) is the demonstrable token reduction. The plan's literal server-side entry tool remains an **open question for the operator**: adopting it would require superseding `tool-exposure-context-economics.md`.

---

## 9. Commands run (reproducible)

```
# SDK currency
npm view @modelcontextprotocol/sdk dist-tags          # latest: 1.30.0 (already installed)

# toolbox gates
pnpm --dir mcp-toolbox run verify                      # exit 0 (typecheck + build + all tests)
pnpm --dir mcp-toolbox run protocol:conformance        # 14/14 pass
pnpm --dir mcp-toolbox run protocol:measure            # table in §4
pnpm --dir mcp-toolbox run protocol:survey             # 3 native / 2 partial / 4 absent
pnpm --dir mcp-toolbox run cards:check                 # all current

# focused app test
cd mcp-toolbox/apps/verification-accountability-mcp
node --test --import tsx test/*.test.ts                # 13/13 pass
```

The full-suite `npm test` was intentionally **not** run (operator resource directive; it spawns PTYs/agents/hub daemons).

---

## 10. Acceptance-criteria status

| AC | Status | Note |
|---|---|---|
| W058-1 conformance smoke in verify | **Met (with discover caveat)** | stateless catalog stability + result contract + Tasks asserted; `server/discover` and TTL lists are SDK-absent and recorded, not hand-rolled |
| W058-2 ≥1 lifecycle tool uses Tasks with progress | **Met at protocol level; hub probe open** | `run_verification_async` + streaming test; env-gated live hub-monitoring probe not run |
| W058-3 token-economy delta measured | **Met** | 69,219 → 9,050 bytes (86.9%) recorded |
| W058-4 CIMD status + EMA decision | **Met** | CIMD advertised-readiness/deferred; EMA DEFER(2026-09-19), W060 owns |
| W058-5 tool-result contract | **Partial** | declared contract + enforcement met; physical text-companion removal deferred (result-bounds interaction) |
| W059-1 all products valid card | **Met** | 14 generated, schema-validated, drift-tested in `verify` |
| W059-2 progressive discovery + measured delta | **Met with recorded deviation** | host-side index (accepted architecture), 86.9% delta; literal server-side entry tool conflicts with `tool-exposure-context-economics.md` |
| W059-3 generated from one source of truth | **Met** | `package.json` + compiled `tools/list`, no duplication |

**Open questions / follow-ups**

1. Operator decision: adopt the literal W059 server-side progressive-discovery entry tool (requires superseding `tool-exposure-context-economics.md` / P702A), or keep host-side?
2. `result-bounds` vs the tool-result deprecation: bound `structuredContent` too, or wait for structured-output-capable hosts?
3. Run the env-gated live hub probe for Tasks progress and record its verdict before any hub-monitoring claim.
4. P702B (progressive-host token measurement on OpenAI Responses) remains backlogged unchanged.
5. If any product gains an HTTP transport, adopt CIMD for registration and revisit ID-JAG.