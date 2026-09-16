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

- **Control-room identity.** Operator chrome — header, panels, badges, composer, tool titles, subjects, code — stays monospace. Conversational prose (assistant markdown, plan/completion/attention/thinking text, welcome) reads in a humanist sans stack. Monospace is for code, data, and measurement, never a costume for prose.
- **One accent, two roles.** `--accent` is the text/outline-safe amber per theme (dark `#e8a33d`, light `#96590c`); `--accent-fill` is the constant amber for fills (user bubbles, send button, toggles, active dots). Advisory-vs-enforced badge semantics are unchanged.
- **Two themes, one token set.** Dark is default; light re-maps the same custom properties under `[data-theme="light"]`. The System/Dark/Light control follows the OS live and applies pre-paint (`theme.ts`, `main.tsx`) so a light operator never sees a dark flash. Syntax-highlight tokens and elevation shadows carry explicit light equivalents.
- **Typed part grammar is the thread's visual system.** Tool cards carry authored per-kind SVG glyphs (ACP `tool_call.kind`), status-colored card edges, and collapsible I/O; unified diffs render with add/del/hunk tinting (`diff-text.tsx`), color backed by `+`/`-` glyph text.
- **Focus mode.** The header toggle hides both rails so the thread centers (≥1101px); below that the layout is already a stacked column with the thread first.
- **Honest motion.** The only authored motion moments are the working-dot pulse and 120ms color/border transitions; `prefers-reduced-motion` disables both.
