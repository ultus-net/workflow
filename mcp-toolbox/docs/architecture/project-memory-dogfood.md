# Project Memory Cross-Context Dogfood

## P703 Scope

P703 evaluates whether the P702 Project Memory product materially improves a real
coding-agent handoff without transferring a transcript. This run was performed on
2026-08-29 with two separate fresh agent contexts sharing only the normal local
Project Memory store and repository filesystem. Producer context
`ses_fb4437cd3ffefeU1Wk6Nnf7Htk` and consumer context
`ses_fb442e12effeyecDth7X7jUscq` were launched independently; the consumer prompt
contained the experiment instructions but none of the producer transcript, memory
IDs, or recorded content. The consumer was also instructed not to inspect planning
or architecture files until after its first memory retrieval.

The progressive-host half of P702A is intentionally deferred to P702B because the
measurement process has no `OPENAI_API_KEY`. The user explicitly allowed P703 to
proceed using the completed eager/explicit exposure evidence. This is a sequencing
exception, not evidence that P702A's progressive acceptance criterion passed.

## Producer

The producer inspected the Stage 7 contracts and recorded three assertions through
the real compiled `project-memory-mcp` stdio server:

| Kind | Content | Associated paths |
| --- | --- | --- |
| decision | Project Memory records are agent assertions, not deterministic proof; memory kind describes retrieval intent rather than proof strength. | `docs/architecture/project-memory-contract.md`, `docs/architecture/accountability-evidence-contract.md` |
| constraint | P702B progressive-host measurement is backlogged until an OPENAI_API_KEY is available to the measurement process; the explicit sequencing override means P702B no longer blocks P703. | `TODO.md`, `docs/architecture/tool-exposure-context-economics.md` |
| lesson | P703 handoff dogfooding must use genuinely separate coding-agent/harness contexts and recover durable decisions/constraints without transcript transfer. | `TODO.md`, `ROADMAP.md` |

The producer deliberately omitted credentials, transcript content, temporary test
records, broad repository summaries, speculative P704 design, and duplicated
context-economics measurements. Connecting to the compiled MCP took 102.9 ms. The
three writes took 5.8 ms, 1.6 ms, and 1.2 ms; the complete producer interaction took
118.4 ms.

## Consumer Retrieval

The fresh consumer queried `Stage 7 P703 handoff`, `Stage 7 evidence proof`,
`Stage 7 sequencing blockers`, and `P703 continuation state` before opening the
repository planning or architecture documents. The four queries returned nine
result instances representing exactly the three unique producer records, with no
reported truncation. There were no irrelevant unique records and no duplicate
stored records among the results; repeated result instances came from intentionally
overlapping queries.

The consumer recovered all three intended material claims: the separate-context/no-
transcript requirement, assertion-level trust semantics, and the explicit P702B/P703
sequencing exception. Connecting to the compiled MCP took 107.7 ms. Searches took
5.8 ms, 1.0 ms, 0.9 ms, and 0.8 ms; the complete consumer MCP interaction took about
121.0 ms. Initial memory context was therefore three unique compact records rather
than a wholesale project-memory dump.

The invocation protocol is reproducible: each context launches the compiled
`apps/project-memory-mcp/dist/server.js` through an MCP SDK `Client` and
`StdioClientTransport`, passes `/var/home/hunter/mcp-toolbox` as `workspaceRoot`, and
uses only `record_memory`/`search_memory`. A fresh consumer receives query goals but
no producer output. This tests durable storage transfer rather than transcript
continuity; the session identifiers above attest which isolated agent executions
were used, but are not promoted to deterministic proof of host isolation.

Repository inspection then confirmed the three assertions against `TODO.md`,
`project-memory-contract.md`, and `accountability-evidence-contract.md`. No retrieved
record was contradicted or obsolete. The sequencing record was materially useful
but lossy: `TODO.md` permits P703 to proceed while P702A remains unchecked, whereas
`tool-exposure-context-economics.md` still correctly states that P702A itself cannot
pass until a progressive strategy is measured. Consumers still need authoritative
repository sources when the distinction between task sequencing and acceptance
status matters.

## Omissions And Context Economics

The handoff did not recover all information needed to execute P703 from memory
alone. In particular, the producer intentionally did not duplicate P703's complete
acceptance checklist or the context-economics evidence into Project Memory. The
consumer therefore needed the repository planning/evidence documents to recover
those details. This is desirable for stable authoritative documentation, but means
Project Memory is a continuity index rather than a replacement for repository
documentation.

The available P702A eager measurement remains the tool-context cost for this run.
Project Memory exposes two tools with a 3,400-byte compact `tools/list` response.
Under OpenCode 1.18.25 with Azure `gpt-chat-latest`, enabling only Project Memory
increased provider-reported input usage by 112 tokens, about 0.10% of the model's
111,616-token input limit. Enabling all seven toolbox servers increased input usage
by 901 tokens, about 0.81%. Cache reads and writes were zero in those controlled
runs. No progressive-host token result is claimed here; P702B remains responsible
for it.

## Result

The bounded Project Memory slice materially improved this handoff. Three compact
assertions recovered the key trust, sequencing, and handoff constraints before the
consumer read repository documentation, with no irrelevant unique retrievals and
about 121 ms end-to-end consumer MCP overhead. The experiment also shows where the
product should remain narrow: durable memory should point a new context toward
material engineering state, not replicate task specifications, deterministic
observations, or architecture evidence.

The initial retrieval contained no stale, contradictory, obsolete, or duplicate
stored records. The experiment then exercised correction rather than merely relying
on unit tests: isolated context `ses_fb4406232ffeQuLUp7oiM6Z7Wv` superseded the
lossy P702B sequencing constraint with an assertion that explicitly distinguishes
permission to proceed with P703 from P702A's still-incomplete status. The old record
was `5e1d4cde-579c-4601-9f42-05f279cdfb04`; its replacement is
`974eedf2-1d22-4e76-b463-b73a2c97a5ae` and retains the old ID in `supersedes`.
A fresh consumer context (`ses_fb43f92dcffeM8g6SiaiVCsZDU`) explicitly launched
the compiled stdio server and searched `P702B` and `progressive-host`. Both searches
returned only the current replacement, with `truncated: false`; the obsolete record
was excluded and no duplicate current record appeared. MCP connect took 107.5 ms
and the searches took 5.1 ms and 1.0 ms.

This demonstrates the existing correction mechanism for an obsolete assertion:
identify a materially lossy current record during handoff review, replace it by
explicit supersession, and let normal search prune the stale version from current
retrieval while retaining provenance in storage. It does not establish a general
automatic low-value detector or retention policy. Those should remain deferred until
natural accumulation produces evidence that automation is needed. The high-
confidence secret detector and local-only store reduce obvious privacy risk but do
not prove arbitrary memory text is secret-free, so callers must continue to avoid
recording credentials or unnecessary private content.
