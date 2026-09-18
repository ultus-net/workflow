# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary operator is a developer running an AI coding session locally. They need ordinary conversational coding ergonomics while retaining clear visibility into Workflow's authorization and verification decisions.

## Product Purpose

Workflow is a control plane for coding-agent hosts: an in-process deterministic authority that lets a model propose work while Workflow remains responsible for task state, legal transitions, authorization, evidence requirements, and verification before canonical state advances. The host SDK is replaceable; the authority is not.

## Positioning

Workflow separates the coding host from workflow authority, the way infrastructure separates control plane from data plane: model and host activity are proposals and observations, while Workflow independently authorizes mutations and validates evidence before state advances. The tooling built on top — monitoring, pedagogy, containment, token economy, review gates — survives swapping the host underneath.

## Operating Context

The primary interface is the browser operator UI launched by `workflow` (OpenCode in ACP mode by default), with terminal surfaces (`workflow-tui --driver acp|opencode`) and the retained vendored-Cline fallback. The operator converses with a coding agent, observes tool activity, can cancel active work, and needs blocking reasons, enforcement level, containment-relevant policy state, and verification outcomes to remain diagnosable without displacing the coding conversation.

## Capabilities and Constraints

- Canonical invariant: `model proposes -> Workflow authorizes -> tool acts -> environment supplies evidence -> Workflow validates -> state may advance`.
- UI state is projection and presentation state only; kernel/application state remains authoritative.
- `advisory` enforcement must never appear equivalent to `enforced` enforcement.
- The TUI must never override the terminal's theme: foreground accents pull only the themeable ANSI-slot names (remapped by the user's terminal), the sole background is the OSC 11-sampled composer tint, and the interface degrades to plain text under `NO_COLOR`. Semantics stay readable through text, markers, emphasis, and layout alone (decision 2026-09-16, `docs/TUI_INTEGRATION.md`).
- Workflow supports interactive development and bounded autonomy. Safety semantics must not be weakened for UI or SDK convenience.
- Stock-ACP OpenCode is the lead runtime (browser default; `WORKFLOW_ACP_AGENT=opencode`). Goose (AAIF) is the qualified general-purpose/backup agent (`WORKFLOW_ACP_AGENT=goose`). The vendored patched Cline runtime remains a selectable fallback; its full retirement is evidence-gated (W050), never date-gated.

## Brand Commitments

The product name is Workflow. Across surfaces, ordinary coding-agent interaction (conversational prompts, streamed tool activity, cancellation, model/mode switching) is the familiar reference; Workflow supervision stays contextual rather than replacing it with a workflow-dashboard interaction model.

## Evidence on Hand

The repository contains the Workflow application/kernel contracts, the OpenCode and goose ACP runtime integrations plus the retained vendored-Cline fallback, the browser operator UI, terminal surfaces, a working but rejected diagnostic Ink TUI, operator documentation, and automated surface/runtime tests. No claims beyond those implemented and documented capabilities should be fabricated in the interface.

## Product Principles

- Keep the coding conversation primary and Workflow supervision contextual.
- Make authorization, blocking, enforcement, and verification observable without making operators manage canonical state manually during ordinary coding.
- Preserve deterministic Workflow authority across every host and UI integration.
- Fail closed at safety boundaries and describe enforcement strength precisely.
- Prefer familiar coding-agent interactions over novel terminal chrome.
