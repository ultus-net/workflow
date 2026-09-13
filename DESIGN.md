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
