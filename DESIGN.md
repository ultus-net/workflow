# Workflow Interface Design

## Direction

The standalone TUI is exact Cline CLI `3.0.61`'s interactive interface under Workflow supervision, not a Workflow approximation of a coding-agent terminal. Workflow preserves Cline's interaction model. The patch changes exactly:

1. The mandatory pre-tool authorization seam (`/before-tool`) and contained-bash execution route (`/bash`).
2. Token-economy plumbing: lazy MCP tool discovery, bounded MCP result truncation, and MCP notification forwarding into the tool-update surface.
3. A Workflow task panel driven by the hub `/snapshot`, plus `--cwd` argument handling and Ctrl+C scoped to the active turn.
4. The home animation: Cline's pointer-tracking robot is replaced with an original, authorship-clean ASCII galaxy swirl (`workflow-galaxy.tsx`), cycling frames on a fixed interval. No third-party artwork is imported. Onboarding screens keep upstream art.

It deliberately does **not** touch Cline's terminal theme, palette, or layout.

## Hierarchy

Cline owns the conversation hierarchy, composer, menus, dialogs, Plan/Act controls, queueing, commands, and mentions. Workflow task/evidence state remains application-owned and must not be reimplemented as presentation state inside Cline.

## Terminal Language

The runnable TUI keeps Cline's terminal rendering and theme behavior. Workflow does not add semantic foreground/background styling. The one presentation override is the home animation: the robot is replaced by the galaxy swirl; the galaxy inherits the terminal's default foreground (no custom colors).

## Interaction

Cline owns keyboard and interaction behavior. Workflow must not advertise or emulate a parallel subset of Cline's `/` commands, `@` mentions, Plan/Act switching, dialogs, queueing, or cancellation behavior.

## Responsive Behavior

Responsive terminal behavior is upstream Cline behavior. Workflow's patch must not introduce a second layout system.

## Web Surface (browser operator UI)

Direction and language of `src/ui/webapp` (basis: `docs/CHAT_UI_RESEARCH_2026.md`). This section reflects the 2026-09-18 battlestation pass (branch `feat/web-ui-battlestation`).

- **Pages behind top-bar nav slugs.** A slim header carries the focus-mode toggle, the `Workflow` wordmark, **nav slugs (icon over name, square, mono)** for **Chat · Sessions · Usage**, the active session title, the enforcement badge, and the settings gear. Sessions and Usage are pages; session history is *not* a sidebar panel — the Sessions page and the `/sessions` composer command (with `/chat` and `/usage`) are its homes. Below 1100px the slugs keep their icons and drop the names.
- **Parallel sessions, one focused at a time.** Multiple live ACP runtimes run side by side (server-side cap with LRU eviction); the chat view focuses one session, and every session-scoped fetch/poll/mutation carries that session's id (`?session=`). New sessions pick their agent at creation; the Sessions page shows live facts per card (run dot = turn in flight, focused tag, agent, relative time) with focus/open-chat, agent switch, rename, dismiss, and clear-unused. Parked permission prompts are per session — switching focus never cancels another session's prompt.
- **Three-region chat layout.** In the chat view a left **sidebar** (collapsible **git worktree list** that starts closed, then repository changes), the centered **chat column**, and a right **inspector** (tasks first, then evidence and history). The composer is the focal card — square-edged, provider/model/effort/mode chips, attach and send in its footer. Below 1100px the **rails collapse away entirely**: half-screen is a first-class chat layout (full-width composer, status bar intact), not a squished three-column grid.
- **Bottom status bar — the session's facts, left to right.** Context-window fill + tokens + cost far **left**; model + branch in the **middle**; the agent's ACP handshake version (`opencode vX`) far **right**. Unknown data renders nothing (never a placeholder); below 900px the middle yields space. The composer-adjacent usage meter is gone — the status bar is the single usage readout.
- **Control-room identity.** Operator chrome — header, panels, badges, composer, tool titles, subjects, session titles, code — stays monospace. Conversational prose (assistant markdown, plan/completion/attention/thinking text, welcome) reads in a humanist sans stack. Monospace is for code, data, and measurement, never a costume for prose.
- **One accent, two roles.** `--accent` is the text/outline-safe accent per theme (Workflow amber by default: dark `#e8a33d`, light `#96590c`); `--accent-fill` is the fill accent (user bubbles, send button, toggles). Status colors must pass AA as text *on their own 10% diff tints*, not only on bare surfaces. Advisory-vs-enforced badge semantics are unchanged and do not follow the palette.
- **Palettes (opt-in, catalog).** The settings Appearance section offers the **OpenCode desktop theme catalog** (37 themes, vendored JSON, MIT — engine ported in `theme/color.ts` + `theme/resolve.ts`, AA-corrected per theme). The palette choice is orthogonal to System/Dark/Light, persists, and applies pre-paint; **Workflow amber stays the default identity** and `styles.css :root` remains the source of truth for it.
- **Typed part grammar is the thread's visual system.** Tool cards carry authored per-kind SVG glyphs (ACP `tool_call.kind`), status-colored card edges, and collapsible I/O; unified diffs render with add/del/hunk tinting (`diff-text.tsx`) — classification requires a structural marker (`@@`/`diff --git`) so ordinary content with `+`/`-` prefixes is never misreported as a diff, and color is backed by `+`/`-` glyph text. Clicking a changed file in the sidebar opens a proper diff popout (a wide modal sharing the settings chrome) rather than a cramped inline expansion.
- **Focus mode.** The header toggle hides both side panels so the thread centers (≥1101px); below that the rails are hidden by the responsive rules anyway. The state lives at the app root, so the header button and the settings dialog's Focus mode row are always one setting.
- **One settings surface.** Every operator preference lives in the settings dialog (`settings-dialog.tsx`, opened by the header gear or Ctrl/Cmd+,): appearance (theme mode + palette + focus mode), all agent-advertised options (provider, model, effort, mode, tool toggles — synced with the composer chips through the same state, with the full searchable combobox + favourites for long lists), approvals and capabilities, transcript and notifications, the keyboard map, and the session's authority facts. Composer chips remain for speed; the dialog is the complete map. It is a sectioned list of rows — long catalogs (the palette) stack label-over-control — with `role="dialog"`, focus trap, Esc, and focus return; while open it owns the keyboard.
- **Honest motion.** Motion is limited to micro-transitions — the working-dot pulse, toggle tracks, chip and hover fades, and the disclosure chevron rotation; the pulse, toggle tracks, and chip transitions stop under `prefers-reduced-motion`. No animation is decorative.
- **Testing is part of the surface.** `node --import tsx --test test/webui-e2e.test.ts` drives real Chromium over raw CDP (no Playwright dependency) against a scripted fake agent: boot, one streamed turn, palette switch, console/exception cleanliness; SSR pins (`test/webapp-surface.test.ts`) hold markup and square-edge invariants; `test/webapp-palettes.test.ts` gates every palette × mode on WCAG AA; `test/openrouter-analytics.test.ts` pins the usage data path.

## Operator Preferences

Recorded verbatim from the operator; these are binding constraints, and later frontend refinement passes must preserve them.

0. **The point: this is the operator's AI battlestation — a universal ACP remote.** The web surface exists to be one screen from which the operator drives *any* ACP agent (Cline, OpenCode, and whatever comes next) with total control. Universality is the product: every agent is switchable in place, and every capability an agent advertises over ACP is reachable from this one surface. Design and refinement decisions are judged against that standard — if an ACP agent can do it, the battlestation must be able to reach it.

1. **Sharp square edges — never rounded corners.** The aesthetic is brutal / square, in the spirit of the OpenCode terminal UI: dense, monospace-forward, hard-edged. Every corner is square — cards, panels, inputs, buttons, chips, badges, popovers, toggles, meters, scrollbars, and status dots. No `border-radius` other than `0`. This overrides any earlier "rounded card" or "circular button" direction: the composer attach and send buttons, the settings dialog, and the diff popout are all square.

2. **The settings menu surfaces every ACP option — it is the canonical, complete set.** Every option the agent adapter surfaces (ACP `configOptions`) must appear in the settings menu, with no removals. The composer / front screen is then a curated subset of those options: we refine which of them to promote to the front screen over time, but nothing is promoted at the cost of removing it from settings. Adding a new adapter option must add its control to settings, never replace or hide an existing one.
3. **Brutalist, control-room register is approved.** The current dark, square, monospace-forward control-room look is the accepted direction; refine within it rather than soften it.
4. **The operator's choices persist — never revert to the agent's factory default.** The last-used value of every ACP option (above all the model) is restored on the next session and survives reload. The surface must never fall back to the agent's out-of-box default (e.g. always Claude Sonnet) once the operator has chosen otherwise. Favourites persist and load alongside. Reverting the operator's choices is a regression.

### Resolved defects

- **Model selector auto-closes — fixed.** The combobox popover no longer closes while the operator scrolls the list (the scroll handler ignores the list's own scroll); it stays open until a choice, Escape, or a genuine outside click. The popover is portalled to `<body>` with fixed positioning, escapes ancestor `overflow: hidden`, sits above the settings backdrop (z-index 60 > 40), and flips/clamps to stay on-screen.
- **Model selection reverting to the factory default — fixed.** The operator's last-used value for every ACP option persists (localStorage) and is restored over the agent's factory default; favourites load alongside.

### Follow-up directions

- **Mine the OpenCode UI for refinement.** The OpenCode interface is a reference for the next refinement pass (with other frontend skills). Patterns to evaluate borrowing: the right inspector rail (live LSP servers, MCP connections, the task/todo list), the bottom status bar (model · token usage · cost · agent version), the inline diff rendering with red/green hunks, and the queued-message affordance. Adopt what strengthens the battlestation within the brutal square-edge register; do not import rounded or softened treatments.
