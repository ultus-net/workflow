# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary operator is a developer running an AI coding session locally. They need ordinary conversational coding ergonomics while retaining clear visibility into Workflow's authorization and verification decisions.

## Product Purpose

Workflow is an in-process deterministic authority for coding-agent hosts. It lets a model propose work while Workflow remains responsible for task state, legal transitions, authorization, evidence requirements, and verification before canonical state advances.

## Positioning

Workflow separates the coding host from workflow authority: model and host activity are proposals and observations, while Workflow independently authorizes mutations and validates evidence before state advances.

## Operating Context

The primary interface is a standalone terminal coding UI used inside a local project. The operator converses with a coding agent, observes tool activity, can cancel active work, and needs blocking reasons, enforcement level, containment-relevant policy state, and verification outcomes to remain diagnosable without displacing the coding conversation.

## Capabilities and Constraints

- Canonical invariant: `model proposes -> Workflow authorizes -> tool acts -> environment supplies evidence -> Workflow validates -> state may advance`.
- UI state is projection and presentation state only; kernel/application state remains authoritative.
- `advisory` enforcement must never appear equivalent to `enforced` enforcement.
- The TUI must not depend on semantic foreground or background colors; it inherits the terminal theme and communicates through text, markers, emphasis, and layout.
- Workflow supports interactive development and bounded autonomy. Safety semantics must not be weakened for UI or SDK convenience.
- Cline is the current runtime used by the standalone TUI. OpenCode integration is separately contract-qualified.

## Brand Commitments

The product name is Workflow. For the coding TUI, Cline's usable terminal interaction is the primary familiar reference; OpenCode and Crush are secondary interaction references. Familiar coding-agent ergonomics should be preserved rather than replaced with a workflow-dashboard interaction model.

## Evidence on Hand

The repository contains the Workflow application/kernel contracts, Cline runtime integration, a working but rejected diagnostic Ink TUI, browser projection, operator documentation, and automated TUI/runtime tests. No claims beyond those implemented and documented capabilities should be fabricated in the interface.

## Product Principles

- Keep the coding conversation primary and Workflow supervision contextual.
- Make authorization, blocking, enforcement, and verification observable without making operators manage canonical state manually during ordinary coding.
- Preserve deterministic Workflow authority across every host and UI integration.
- Fail closed at safety boundaries and describe enforcement strength precisely.
- Prefer familiar coding-agent interactions over novel terminal chrome.
