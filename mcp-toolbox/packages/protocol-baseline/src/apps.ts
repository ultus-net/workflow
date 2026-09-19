/**
 * Single source of truth for the toolbox product inventory.
 *
 * The card generator, the conformance smoke, and the token measurement all
 * iterate this list. A product is discovered from the filesystem and must
 * have a `dist/server.js` after a workspace build.
 */

export interface AppDescriptor {
  /** Directory name under `apps/`. */
  readonly id: string;
  /** Tool names that are intentionally content-only (no outputSchema). */
  readonly contentOnlyTools: readonly string[];
  /** A task-based tool name when the product ships the Tasks extension. */
  readonly taskTool?: string;
}

export const APPS: readonly AppDescriptor[] = [
  { id: "browser-verification-mcp", contentOnlyTools: [] },
  { id: "change-intelligence-mcp", contentOnlyTools: [] },
  { id: "ci-intelligence-mcp", contentOnlyTools: [] },
  { id: "code-intelligence-mcp", contentOnlyTools: [] },
  { id: "continuity-checkpoint-mcp", contentOnlyTools: [] },
  { id: "egress-audit-mcp", contentOnlyTools: [] },
  { id: "git-intelligence-mcp", contentOnlyTools: [] },
  { id: "learning-mcp", contentOnlyTools: [] },
  { id: "project-context-mcp", contentOnlyTools: [] },
  { id: "project-memory-mcp", contentOnlyTools: [] },
  { id: "review-accountability-mcp", contentOnlyTools: [] },
  { id: "skills-mcp", contentOnlyTools: [] },
  { id: "test-intelligence-mcp", contentOnlyTools: [] },
  {
    id: "verification-accountability-mcp",
    contentOnlyTools: [],
    taskTool: "run_verification_async",
  },
  { id: "workflow-fs-exec-mcp", contentOnlyTools: [] },
  { id: "workflow-guard-mcp", contentOnlyTools: ["guard_check", "guard_status"] },
];

export function findApp(id: string): AppDescriptor {
  const app = APPS.find((entry) => entry.id === id);
  if (!app) throw new Error(`unknown app: ${id}`);
  return app;
}