---
target: the Workflow Control browser operator UI page
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-09-15T03-28-23Z
slug: src-ui-webapp-app-tsx
---
# Design Critique — Workflow Control (browser operator UI)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Host label, Cancel-swap, completion markers, task states; no explicit "agent working" indicator, silent poll failures |
| 2 | Match System / Real World | 3 | Chat conventions solid; "ADVISORY / acp" and task-state jargon unexplained |
| 3 | User Control and Freedom | 3 | Cancel mid-run, attachment remove; no undo for Advance, no transcript clear |
| 4 | Consistency and Standards | 4 | Uniform part styling, buttons, state labels |
| 5 | Error Prevention | 3 | Send disabled while running, server validation; client error surfacing is generic |
| 6 | Recognition Rather Than Recall | 3 | Visible panels; Advance requires knowing the state machine; enforcement meaning needs docs |
| 7 | Flexibility and Efficiency | 2 | Enter-to-send and paste work; no other shortcuts, no keyboard task control |
| 8 | Aesthetic and Minimalist Design | 3 | Clean and focused; 1px image speck in bubble; big empty mobile gap |
| 9 | Error Recovery | 3 | FAILED part renders in-thread, but as raw JSON jargon without next steps |
| 10 | Help and Documentation | 1 | No inline help/tooltips; welcome line is the only guidance |
| **Total** | | **28/40** | **Good** |

## Design Specificity Verdict

**LLM assessment:** Partially authored. The supervision rail (Tasks/Evidence/History), the operator part family (action/outcome/attention/completion), and the enforcement label carry genuine Workflow identity. The chat column is deliberately conventional — aligned with the product principle of preserving familiar coding-agent ergonomics — so interchangeability there is a choice, not slop. Missed opportunity: the enforcement label is the product's most distinctive honesty signal and it is also its least explained element.

**Deterministic scan:** 1 finding — `side-tab` accent border at styles.css:354 (blockquote in rendered markdown). Assessed a **false positive**: a left accent border is the canonical blockquote convention in chat/markdown surfaces (GitHub/Slack/Discord), not decorative card chrome.

**Visual overlays:** unavailable — the page's own CSP (`script-src 'self'`) blocked detector injection. The CSP doing its job is itself positive evidence; the CLI scan and screenshots carry the evidence load.

## Overall Impression

A clean, honest operator console with a real product spine. The gap between "works" and "feels finished" lives in three places: failure moments (raw JSON errors), status silence (no working indicator, silent reconnects), and the unexplained enforcement badge.

## What's Working

1. **The operator part family** — action/outcome/attention/completion rows make the authorization narrative visible in-thread; this is the product's differentiator rendered, not described.
2. **Enforcement honesty in the header** — `ADVISORY / acp` implements "advisory must never appear equivalent to enforced" in one glanceable token.
3. **Resilient state model** — thread state is server-owned; refresh mid-turn loses nothing (Riley-proof), and the completion marker closes turns cleanly.

## Priority Issues

- **[P1] Failure turns render raw JSON-RPC errors.** Why: the emotional low point of the product (the agent just failed) is where the UI dumps `{"code":-32603,"message":"Internal error…"}` — jargon, no cause, no next step. Fix: map known failure classes (API unreachable, cancelled, authority denied) to plain-language summaries with the raw detail collapsed/secondary. Suggested command: `$impeccable clarify` + `$impeccable harden`.
- **[P2] No visible "agent is working" state.** Why: during a run the only signal is Send→Cancel button swap; a user glancing mid-turn can't tell thinking from stalled. Fix: subtle status line in the thread ("agent is working…" pulsing dot) tied to isRunning. Suggested command: `$impeccable animate`.
- **[P2] The enforcement badge is cryptic.** Why: `ADVISORY / acp` is the product's core safety claim and no one outside the project can parse it. Fix: title/aria tooltip expanding to plain language ("Advisory: agent actions are reviewed; mutations are not pre-authorized"). Suggested command: `$impeccable clarify`.
- **[P2] Tiny/broken image rendering in user bubbles.** Why: small attached images render as an unexplained speck (observed with a 1×1 test image). Fix: min dimensions + object-fit cover for thumbnails under a size floor. Suggested command: `$impeccable polish`.
- **[P3] Mobile chat column leaves a large dead gap** with short threads (min-height 60vh regardless of content). Fix: let the viewport grow with content up to a cap. Suggested command: `$impeccable adapt`.

## Persona Red Flags

- **Alex (power user):** No keyboard path to Cancel a run or to Advance a task; Enter-to-send and paste are the only accelerators. Session history is the natural next power feature (already in flight).
- **Sam (accessibility):** Buttons/inputs have aria-labels, but no custom `:focus-visible` styling on the amber/ghost buttons (focus trail depends on browser defaults); BLOCKED tasks dim to 0.55 opacity — borderline contrast; the Send→Cancel swap is the only running indicator (state change may not be announced).
- **Riley (stress tester):** Refresh mid-turn is safe (server-owned state). Double-submit is silently swallowed (409 with no visible note). Failure turns expose raw JSON. Long text wraps correctly.

## Minor Observations

- The History panel entries (`W001: READY → IN_PROGRESS`) are the clearest Workflow-native copy in the UI — more of this voice would help elsewhere.
- `COMPLETED` marker with empty body reads slightly orphaned when the completion text was deduped; a subtle check glyph would close the turn more warmly.
- Attach "+" button is discoverable but its image-only scope (no docs/files) is unstated.
- Evidence panel "none observed" and History "no transitions" empty states are honest and quiet — good.

## Questions to Consider

- What would the enforcement badge look like if it were the product's proudest element instead of its smallest?
- Should a failed turn offer a one-click "retry" path, or is explicit re-prompting the safer product stance?
- Does the right rail belong in the chat column as collapsible context on mobile, or is below-the-fold the right home for it?
