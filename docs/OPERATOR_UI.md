# Operator UI principles

## Purpose

Workflow's interactive surfaces exist to help a human understand, direct, and
trust an agent session. They are not log viewers. The default presentation must
answer, at a glance:

- What is the agent trying to do now, and why?
- What meaningful action just happened and what was its outcome?
- Is anything waiting for operator approval or attention?
- Is Workflow enforcing the expected policy and containment boundaries?
- What changed, and what verification evidence supports the result?

Raw protocol traffic and lifecycle telemetry remain useful for troubleshooting,
but they are diagnostics and must not dominate the normal operator experience.

## Default information hierarchy

The primary transcript is **intent + actions**. It shows concise agent intent,
meaningful tool actions and results, approvals, policy/containment decisions,
changes, and verification. Repeated lifecycle transitions, opaque request/tool
IDs, raw JSON payloads, duplicate command echoes, and transport bookkeeping are
collapsed into diagnostics by default.

The UI should summarize events semantically rather than merely filtering lines.
For example, a file read is useful as `Read README.md`; the sequence `pending ->
in_progress -> completed` for an opaque tool ID is not. Failures and denied
actions remain prominent because they change what the operator should do next.

## Interaction principles

- Settings and menus are persistent, keyboard-navigable surfaces. Opening the
  options menu allows the operator to move between items and make multiple
  changes without the menu disappearing after each selection.
- Current values and pending choices are visible before activation. Destructive
  or authority-changing actions require an explicit interaction rather than an
  incidental keypress.
- Streaming should stabilize the screen instead of continuously reprinting
  low-level state. Human-readable summaries update in place where practical.
- Detail uses progressive disclosure: routine information stays compact;
  diagnostics, raw tool inputs/results, IDs, and protocol events are available
  on demand.
- Terminal, browser, and desktop surfaces should present the same session
  semantics and authority state even when their interaction widgets differ.

## Reuse before invention

Workflow should not build generic chat, streaming, markdown, code-block,
tool-call, approval, settings, history, command-palette, accessibility, or
desktop-shell primitives when maintained ecosystem components already solve the
problem well. Before adding a custom UI primitive, check mature libraries and
record why an existing component cannot satisfy the requirement.

Frameworks own presentation mechanics; Workflow owns semantics and authority.
No UI framework may become the source of truth for authorization, task state,
evidence, containment, verification, or session identity. Those remain behind
the Workflow application/hub boundary and are projected into each UI.

The web surface is the preferred place to adopt feature-complete interaction
libraries. The terminal remains valuable for local operation and recovery, but
parity work should focus on clear operator signal rather than recreating every
browser interaction primitive in Ink.

## Acceptance criteria

A primary interactive surface is ready for daily use when:

- an operator can explain the agent's current intent and last meaningful action
  without reading protocol events;
- policy, containment, approval, task, and verification state are visible when
  consequential and quiet when routine;
- raw telemetry is accessible without being in the default transcript;
- menus remain open while navigating and changing settings until explicitly
  closed;
- common UI mechanics come from maintained libraries where practical; and
- the surface consumes shared Workflow session semantics rather than creating
  an independent authority model.

See `docs/TUI_PARITY.md` for terminal-specific convergence gates and
`docs/HUB.md` for the canonical authority boundary.
