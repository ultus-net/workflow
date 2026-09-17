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

Direction and language of `src/ui/webapp` (basis: `docs/CHAT_UI_RESEARCH_2026.md`):

- **Three-region operator layout.** A slim header (focus-mode toggle, `Workflow` wordmark, active session title, enforcement badge, settings gear) over a flex body: a left **sidebar** (sessions + repository changes), the centered **chat column**, and a right **inspector** (tasks, evidence, history). Below 1100px it stacks chat-first. The composer is the focal card — a raised, rounded card holding the prompt with provider/model/effort/mode chips plus attach and send in its footer row; one usage readout (context-window fill bar + tokens + cost) sits beneath it.
- **Control-room identity.** Operator chrome — header, panels, badges, composer, tool titles, subjects, code — stays monospace. Conversational prose (assistant markdown, plan/completion/attention/thinking text, welcome) reads in a humanist sans stack. Monospace is for code, data, and measurement, never a costume for prose.
- **One accent, two roles.** `--accent` is the text/outline-safe amber per theme (dark `#e8a33d`, light `#96590c`); `--accent-fill` is the constant amber for fills (user bubbles, send button, toggles). Status colors must pass AA as text *on their own 10% diff tints*, not only on bare surfaces. Advisory-vs-enforced badge semantics are unchanged.
- **Two themes, one token set.** Dark is default; light re-maps the same custom properties under `[data-theme="light"]`. The System/Dark/Light control (hook mounted at the app root; the settings dialog only reads/writes) follows the OS for the whole session and applies pre-paint (`theme.ts`, `main.tsx`) so a light operator never sees a dark flash and a focus-mode operator never sees both rails for a frame. Syntax-highlight tokens and elevation shadows carry explicit light equivalents.
- **Typed part grammar is the thread's visual system.** Tool cards carry authored per-kind SVG glyphs (ACP `tool_call.kind`), status-colored card edges, and collapsible I/O; unified diffs render with add/del/hunk tinting (`diff-text.tsx`) — classification requires a structural marker (`@@`/`diff --git`) so ordinary content with `+`/`-` prefixes is never misreported as a diff, and color is backed by `+`/`-` glyph text. Clicking a changed file in the sidebar opens a proper diff popout (a wide modal sharing the settings chrome) rather than a cramped inline expansion.
- **Focus mode.** The header toggle hides both side panels so the thread centers (≥1101px); below that the layout is already a stacked column with the thread first. The state lives at the app root, so the header button and the settings dialog's Focus mode row are always one setting.
- **One settings surface.** Every operator preference lives in the settings dialog (`settings-dialog.tsx`, opened by the header gear or Ctrl/Cmd+,): appearance and focus mode, all agent-advertised options (provider, model, effort, mode, tool toggles — synced with the composer chips through the same state, with the full searchable combobox + favourites for long lists), approvals and capabilities, transcript and notifications, the keyboard map, and the session's authority facts. Composer chips remain for speed; the dialog is the complete map (value-level metadata like combobox favourites stays with its own control). It is a sectioned list of rows, not a card grid; `role="dialog"` with focus trap, Esc, and focus return, and while it is open it owns the keyboard — `/` and Alt+N do not fire behind the modal.
- **Honest motion.** Motion is limited to micro-transitions — the working-dot pulse, toggle tracks, chip and hover fades, and the disclosure chevron rotation; the pulse, toggle tracks, and chip transitions stop under `prefers-reduced-motion`.
