# Browser Verification MCP

Bounded, evidence-producing browser verification over the Chrome DevTools
Protocol (CDP). It drives a real browser to navigate, act, and assert against a
running application, then emits structured, hash-stamped observations that
`verification-accountability-mcp` admits as external evidence — the
"evaluator drives the real app" pattern, without adopting a third-party
browser MCP server.

The debugging/perf profile (console, network, trace summaries) is a second
mode of the same bounded surface.

## Trust boundaries (read this first)

- **Page content is untrusted input.** Everything read from the page —
  accessibility names, attribute values, text, titles, network entries — is
  attacker-influenceable data. The tool *observes*; it never authorizes
  anything, and its output is evidence, not truth.
- **No arbitrary script execution.** There is no `evaluate` tool and the
  implementation never issues `Runtime.evaluate`, `Runtime.callFunctionOn`,
  `Page.addScriptToEvaluateOnNewDocument`, or `Network.loadNetworkResource`.
  Interaction uses the DOM/Input domains only, with allowlisted action kinds
  and an allowlisted key set.
- **No shell and no downloads.** The server never spawns a shell and never
  downloads a browser. It connects to a Chrome you already run
  (`BROWSER_VERIFICATION_CDP_URL`) or launches one you point at
  (`BROWSER_VERIFICATION_CHROME_PATH`).
- **Bounded surface.** Selectors, URLs, input text, screenshots, evidence
  records, console/network/trace entries, and command durations are all
  capped. Model-visible text is bounded by the vendored `result-bounds`
  helper (48k middle-cut).
- **Page subresources are Chrome's behavior, not the tool's.** A hostile page
  can fetch endlessly or run its own scripts; that is the browser executing
  page code. The tool itself never adds network fetches or scripts, and the
  live probe confirms it still returns bounded evidence on a hostile page.
- **Evidence is structural provenance, not a signature.** Each record's
  SHA-256 stamp covers its canonical body and chains to the previous record,
  but a party who controls the process could reconstruct a self-consistent
  chain. Treat the stamp as tamper-evidence for handoffs, not as a
  cryptographic attestation.

## Configuration

| Variable | Meaning |
|---|---|
| `BROWSER_VERIFICATION_CDP_URL` | HTTP endpoint of a running Chrome with remote debugging (e.g. `http://127.0.0.1:9222`). |
| `BROWSER_VERIFICATION_CHROME_PATH` | Executable to launch (headless) when no CDP URL is given. No browser is ever downloaded. |
| `BROWSER_VERIFICATION_CHROME_ARGS` | JSON array of extra launch arguments. |
| `BROWSER_VERIFICATION_ALLOWED_ORIGINS` | Comma-separated origin allowlist for navigation. Empty means any http(s) origin. |
| `BROWSER_VERIFICATION_PROFILE` | `verification` (default) or `debug`. Selects the tool surface. |
| `BROWSER_VERIFICATION_COMMAND_TIMEOUT_MS` | Per-CDP-command timeout (clamped). |
| `BROWSER_VERIFICATION_NAVIGATION_TIMEOUT_MS` | Navigation/load timeout (clamped). |

## Tools

**Verification profile:** `navigate`, `snapshot_accessibility`,
`perform_action` (click / type / clear / press), `take_screenshot`,
`run_assertion`, `run_verification`, `list_evidence`, `get_evidence`.

`run_verification` is the admission-grade call: it runs a bounded
navigate/act/assert flow and returns one observation. `verification-accountability-mcp`
calls it through its configured browser authority and stores the resulting
observation with the observed-at time and the `browser-verification-mcp`
capability recorded. Failed and inconclusive flows remain visible evidence and
are never converted into success.

**Debug profile:** `navigate`, `capture_console`, `capture_network`,
`capture_trace`, `list_evidence`, `get_evidence`.

## Evidence contract

Every action produces an observation with:

- `source`: `browser_verification` + capability + profile;
- `action`: kind and bounded detail;
- `subject`: `browser_page` (`url`, `origin`, `pageHash` over url+title);
- `result`: `observed | passed | failed | inconclusive`, assertion counts, truncation;
- `urlBefore` / `urlAfter`, `recordedAt`;
- `hash` (SHA-256 over the canonicalized body) and `previousHash` (chain link);
- `provenance`: tool, CDP target id, session id.

`pageHash` identifies the page that was observed; it enables
`verification-accountability-mcp` to report browser observations as
`fresh`/`stale`/`unknown` against a caller-supplied current page identity.

## Verification

- Always-on: mock-CDP suites (`test/bounds.test.ts`, `test/evidence.test.ts`,
  `test/session.test.ts`, `test/mcp.test.ts`, `test/package.test.ts`) exercise
  protocol handling, bounds, evidence shape, hostile-page behavior, the
  packed artifact, and the MCP boundary without requiring a browser.
- Probe-gated live end-to-end (`test/live-probe.test.ts`): set
  `BROWSER_VERIFICATION_LIVE=1` plus a CDP URL or Chrome path. Without those it
  skips honestly; the mock suites remain the always-on evidence.