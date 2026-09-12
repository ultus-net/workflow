# Workflow

Workflow is an in-process, deterministic workflow authority for agent hosts. Its core invariant is:

```text
model proposes -> Workflow authorizes -> tool acts -> environment supplies evidence -> Workflow validates -> state may advance
```

The kernel owns task state, dependency readiness, legal transitions, evidence requirements, and evidence invalidation. Host SDKs, MCP providers, and UIs are adapters around that authority; they do not own canonical workflow state.

## Current Scope

The v0 prototype currently demonstrates:

- deterministic dependency-derived task readiness and legal transitions;
- evidence bound to subjects and mutation epochs, with stale-evidence invalidation;
- a host-neutral application API and capability-based enforcement reporting;
- native Cline and ACP host translations without host types entering the kernel;
- an MCP capability/evidence boundary that validates external observations before admission;
- default-deny withholding for explicit process, credential, and host-network capabilities at application authorization;
- an opt-in Linux Bubblewrap process backend with empty environment, explicit filesystem grants, and isolated networking by default;
- a standalone Cline `3.0.61` coding TUI with mandatory Workflow authorization, plus replaceable Ink/browser projections over `WorkflowApplication`.

This is not yet a release-ready autonomous execution system. The local JSON store provides versioned restart recovery and single-store writer exclusion. W019 adds a bounded Linux process-containment backend, but complete MCP Toolbox integration and stronger container/VM isolation remain later work.

## Install As An Everyday Tool

Use Node 22 or newer.

```sh
npm install
npm run build          # library + CLI bins
npm run toolbox:install
npm run toolbox:build  # required for the workflow guard
npm run tui:cline:build  # pinned Cline launched by `workflow`

npm i -g .             # from this directory
```

The global `npm i -g .` places three commands on your PATH:

- `workflow` — full TUI (alias for the pinned Cline launcher)
- `workflow-shell` — interactive contained shell
- `workflow-pets` — play a pet package in the terminal

Run against any workspace with `workflow --cwd /path/to/project`. To update,
re-run the build steps above and re-install.

If the toolbox isn't built, the TUI and contained-shell degrade to advisory
(un-guarded) with a visible warning rather than crashing — rebuild with
`npm run toolbox:build` to restore enforcement.

Run the coding TUI against another workspace with `npm run tui -- --cwd /path/to/project` (or `-c /path/to/project`). The launcher builds the pinned Cline CLI tag `cli-v3.0.61` on first use and then starts Cline's native interactive TUI. Slash commands, `@` mentions, Plan/Act controls, menus, queueing, keyboard behavior, and rendering come from that pinned Cline version rather than a Workflow reimplementation.

The patched Cline build requires an authenticated loopback Workflow bridge before its interactive runtime can start. Workflow supplies the pre-tool authorization hook and contained bash executor; if that bridge is absent or cannot initialize, startup fails closed instead of opening an unenforced Cline session. The only upstream presentation override is Cline's robot artwork, replaced with the Workflow mark.

The browser demo listens on `127.0.0.1:4173` by default; set `PORT` to override it. The standalone TUI deliberately assigns no semantic foreground or background colors. It inherits the user's terminal theme and communicates state through labels, markers, emphasis, and layout.

`npm run test:e2e` builds the package and exercises the composed Cline-shaped proposal -> Workflow authorization -> Linux Bubblewrap execution -> mutation/evidence -> verified-state path. It requires a working Bubblewrap installation and fails rather than skips when containment cannot be established.

For a manual containment check, run `npm run contained-shell`. It creates a temporary writable workspace, prints its path, and accepts commands at the `Workflow>` prompt until `exit` or `quit`. Every command gets its own Workflow task and authorization/verification lifecycle, then runs with isolated networking, cleared credentials, and only the shared temporary session workspace writable; the workspace is deleted when the session ends. Each successful command reports `Policy: ALLOW`, `Containment: ENFORCED`, and `Task: VERIFIED`. A denied or nonzero command is reported as `Task: FAILED` without ending the session. Use the printed absolute workspace path when testing a write, for example `printf hello > /tmp/workflow-interactive-.../demo.txt`.

## Architecture

`src/kernel/` is the deterministic domain. It has no host SDK, MCP implementation, model provider, or UI dependency. `TaskGraph` derives readiness from dependencies and is the authority for state transitions, evidence admission, mutation epochs, and invalidation.

`src/application/` is the command/query boundary. `WorkflowApplication` keeps the graph private, authorizes proposed mutations, accepts explicit transition/evidence/mutation commands, and emits read-only snapshots for adapters and UIs.

`src/adapters/` contains replaceable external translations. A host adapter normalizes its lifecycle event into `ProposedToolAction`, reports host capabilities, and translates a `PolicyDecision` back to the host's native control. MCP providers expose discovery/invocation only; `normalizeMcpEvidence` validates observations before they can become evidence.

`src/ui/` contains replaceable presentation adapters. The legacy Ink projection and browser prototype read `WorkflowSnapshot` and issue application commands; neither can directly mutate the task graph. The runnable coding TUI is instead launched from `src/cli/tui.tsx` and reuses pinned Cline's native TUI while routing authorization and contained shell execution back through `WorkflowApplication`.

## Safety Guarantees And Limits

Within one live `WorkflowApplication`, the kernel deterministically rejects illegal task transitions, derives blocked/ready state from dependencies, requires declared fresh passing evidence for verification, and invalidates relevant evidence after a mutation.

`enforced` has a deliberately narrow meaning: the configured host integration guarantees authoritative interception before a mutation and applies Workflow's decision before that mutation occurs. `advisory` means Workflow can evaluate and display policy but cannot guarantee that the host cannot mutate around it. Transport alone proves nothing: an ACP connection remains advisory unless its bridge guarantees authoritative permission interception.

Workflow application policy is not itself a security sandbox. A process outside the intercepted/contained path can bypass in-process policy. W019's optional Linux backend adds a separately evidenced Bubblewrap boundary for processes routed through `WorkflowContainedProcess`; higher-impact operation may still require stronger container/VM controls.

`WorkflowApplication` treats `process`, `credentials`, and `network` as explicit high-blast-radius capability classes and withholds them by default. Operators may opt them in independently of task state; doing so grants application policy permission only. See `docs/RUNTIME_CONTAINMENT.md` for the separate Linux runtime boundary and `THREAT_MODEL.md` for residual risks.

MCP output is external, untrusted input. Shape validation and evidence admission do not prove that an MCP server is truthful or that its observation authority is sufficient for a particular production claim. Evidence requirements must select appropriate authorities and subjects.

`JsonWorkflowStore` can persist tasks, evidence, mutation epoch, and transition history. Saves use a monotonic version plus an exclusive local lock so stale or simultaneous writers cannot silently overwrite a newer version. Restart recovery records orphaned `IN_PROGRESS` work as `FAILED` because its mutation outcome is unknown; `VERIFYING` remains `VERIFYING` for repeat verification. A leftover lock after process/host failure deliberately blocks further writes rather than guessing lock ownership, so this is fail-safe local persistence rather than a distributed or highly available store.

## Extension Contracts

The `mcp-toolbox/` directory vendors the MCP toolbox monorepo (workflow-guard
and companion intelligence servers) as tracked source. This vendored copy is
canonical; the standalone toolbox and opencode-workflow-guard repositories are
retired (see `docs/MCP_TOOLBOX.md`). Build and verify it with
`npm run toolbox:install && npm run toolbox:verify` (requires pnpm 11.5.2). See
`mcp-toolbox/README.md` for the tool catalog and `docs/MCP_INTEGRATION.md` for
the evidence trust boundary.

Pets: the repo can load Petdex/Codex desktop-pet packages (`pet.json` +
lossless `spritesheet.webp`) with a pure TypeScript VP8L decoder and render
them as terminal animations; see `docs/PETS.md`, `npm run pets`. The TUI
integration is currently disabled — see `docs/PETS.md` for findings and
recommendations.

Keep the kernel/application contract portable, but write a concrete adapter for each SDK/tool family. Do not build a universal adapter that guesses host semantics. `docs/HOST_ADAPTERS.md` documents capabilities, conformance expectations, capability classification, and advisory/enforced semantics.

`docs/MCP_INTEGRATION.md` documents provider integration and the evidence trust boundary. MCP remains capability/observation plumbing rather than workflow truth.

`docs/UI_INTEGRATION.md` documents the application API and state-ownership rule for new frontends. `docs/OPERATOR_GUIDE.md` documents deployment-time guarantees, enforcement interpretation, capability grants, persistence recovery, and operational limits.

## Roadmap

`TASKS.md` is the durable roadmap and acceptance criteria. W001-W018 form the reviewed v0 policy/state baseline; W019 is the Linux-first runtime-containment milestone layered on top of it.
