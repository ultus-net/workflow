# UI Integration

UIs project `WorkflowApplication`; they do not own workflow state. A UI may keep presentation state such as focus, selected task, expanded panels, or local form text, but task readiness, blockers, evidence freshness, authorization, and legal transitions remain application/kernel concerns.

Read state through `WorkflowApplication.snapshot()`. The resulting `WorkflowSnapshot` contains host enforcement metadata, mutation epoch, task projections and blockers, admitted evidence, and transition history. Submit changes through explicit application commands such as `transition`, `recordEvidence`, and `recordMutation`; never keep a writable `TaskGraph` in UI state.

```ts
import type { WorkflowApplication } from "../src/index.js";

function taskRows(application: WorkflowApplication) {
  return application.snapshot().tasks.map((task) => ({
    id: task.id,
    state: task.state,
    blockedBy: task.blockers,
  }));
}
```

Render enforcement level visibly when users can act on policy results. `advisory` must not look equivalent to `enforced`. Rejected commands should remain rejected application outcomes rather than being repaired by optimistic UI state.

`src/ui/tui.tsx` and `src/ui/web.ts` demonstrate replaceable renderers over the same application boundary. The Ink renderer is a legacy projection example, not the runnable coding TUI contract. New UIs should be testable against application snapshots and commands without changing kernel contracts.

The default product surface is now the browser operator UI (`src/cli/web-launch.ts`, the `workflow` bin): OpenCode in ACP mode, opened in the platform browser. The OpenCode ACP terminal surface is `src/cli/acp-tui.tsx` (`npm run tui:acp`); `workflow-tui` is the universal driver TUI. The former standalone patched-Cline TUI launcher `src/cli/tui.tsx` was retired 2026-09-18. Workflow's upstream Cline patch (still built for the fallback ACP agent) stays within its documented seams (see `DESIGN.md`): mandatory pre-tool authorization, contained bash execution, token-economy MCP plumbing (lazy discovery, bounded truncation, notification forwarding), a hub-snapshot Workflow task panel, and argument/keyboard scoping. It does not touch Cline's artwork. The authorization bridge is required at startup; the patched Cline runtime fails closed when it is unavailable rather than starting an advisory or unenforced interactive session.
