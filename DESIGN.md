# Workflow Interface Design

## Direction

The standalone TUI is exact Cline CLI `3.0.61`'s interactive interface under Workflow supervision, not a Workflow approximation of a coding-agent terminal. Workflow preserves Cline's interaction model. The patch changes exactly:

1. The mandatory pre-tool authorization seam (`/before-tool`) and contained-bash execution route (`/bash`).
2. Token-economy plumbing: lazy MCP tool discovery, bounded MCP result truncation, and MCP notification forwarding into the tool-update surface.
3. A Workflow task panel driven by the hub `/snapshot`, plus `--cwd` argument handling and Ctrl+C scoped to the active turn.

It deliberately does **not** touch Cline's artwork, home view, or terminal theme.

## Hierarchy

Cline owns the conversation hierarchy, composer, menus, dialogs, Plan/Act controls, queueing, commands, and mentions. Workflow task/evidence state remains application-owned and must not be reimplemented as presentation state inside Cline.

## Terminal Language

The runnable TUI keeps Cline's terminal rendering and theme behavior. Workflow does not add semantic foreground/background styling and does not override Cline's artwork; the robot home art stays as-is. (Earlier animation assets were removed as dead weight.)

## Interaction

Cline owns keyboard and interaction behavior. Workflow must not advertise or emulate a parallel subset of Cline's `/` commands, `@` mentions, Plan/Act switching, dialogs, queueing, or cancellation behavior.

## Responsive Behavior

Responsive terminal behavior is upstream Cline behavior. Workflow's patch must not introduce a second layout system.
