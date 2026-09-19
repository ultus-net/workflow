import { join } from "node:path";

import { APPS, type AppDescriptor } from "./apps.js";
import { listCatalog, type Catalog } from "./catalog.js";
import { readCommittedCard, validateCard } from "./cards.js";
import { findWorkspaceRoot } from "./paths.js";
import { surveySummary } from "./spec.js";
import { contractViolations } from "./tool-result.js";

/** A 2026-07-28 conformance smoke over the real MCP stdio boundary. */

export interface ConformanceCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface AppConformance {
  readonly app: string;
  readonly checks: readonly ConformanceCheck[];
  readonly passed: boolean;
}

function catalogFingerprint(catalog: Catalog): string {
  const entries = catalog.tools
    .map((tool) => ({ name: tool.name, input: tool.inputSchema, output: tool.outputSchema }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(entries);
}

export async function runAppConformance(
  app: AppDescriptor,
  workspaceRoot: string = findWorkspaceRoot(),
): Promise<AppConformance> {
  const appDir = join(workspaceRoot, "apps", app.id);
  const checks: ConformanceCheck[] = [];

  const catalog = await listCatalog(appDir);
  checks.push({
    name: "catalog_nonempty",
    passed: catalog.tools.length > 0,
    detail: `${catalog.tools.length} tools advertised`,
  });

  const violations = contractViolations(catalog, app.contentOnlyTools);
  checks.push({
    name: "tool_result_contract",
    passed: violations.length === 0,
    detail:
      violations.length === 0
        ? `every tool declares an output schema or is allowlisted (${app.contentOnlyTools.length} allowlisted)`
        : violations.map((violation) => `${violation.tool}: ${violation.reason}`).join("; "),
  });

  if (app.taskTool !== undefined) {
    const tool = catalog.tools.find((entry) => entry.name === app.taskTool);
    checks.push({
      name: "tasks_extension",
      passed: tool?.execution?.taskSupport !== undefined,
      detail:
        tool === undefined
          ? `task tool ${app.taskTool} is not advertised`
          : `taskSupport=${String(tool.execution?.taskSupport)}`,
    });
    const tasksCapability = (catalog.capabilities as { tasks?: unknown }).tasks;
    checks.push({
      name: "tasks_capability",
      passed: tasksCapability !== undefined,
      detail: tasksCapability === undefined ? "tasks capability not declared" : "tasks capability declared",
    });
  }

  // Stateless-catalog check: two independent server processes must advertise the
  // identical catalog. This is the strongest form of "no connection-local
  // catalog" available at the smoke level (the SDK has no server/discover).
  const [a, b] = await Promise.all([listCatalog(appDir), listCatalog(appDir)]);
  checks.push({
    name: "stateless_catalog_stable",
    passed: catalogFingerprint(a) === catalogFingerprint(b),
    detail: "two independent processes advertised identical tool definitions",
  });

  const committed = readCommittedCard(appDir);
  if (committed === undefined) {
    checks.push({ name: "server_card", passed: false, detail: "no .well-known/server-card.json" });
  } else {
    try {
      const card = validateCard(JSON.parse(committed));
      checks.push({
        name: "server_card",
        passed: card.name.length > 0,
        detail: `valid card for ${card.name}@${card.version} (${card.tools.length} tools)`,
      });
    } catch (error) {
      checks.push({
        name: "server_card",
        passed: false,
        detail: `invalid card: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { app: app.id, checks, passed: checks.every((check) => check.passed) };
}

export async function runConformance(workspaceRoot: string = findWorkspaceRoot()): Promise<readonly AppConformance[]> {
  const reports: AppConformance[] = [];
  for (const app of APPS) reports.push(await runAppConformance(app, workspaceRoot));
  return reports;
}

export function conformanceSummary(reports: readonly AppConformance[]): {
  readonly apps: number;
  readonly passed: number;
  readonly failed: readonly string[];
  readonly spec: ReturnType<typeof surveySummary>;
} {
  const failed = reports.filter((report) => !report.passed).map((report) => report.app);
  return { apps: reports.length, passed: reports.length - failed.length, failed, spec: surveySummary() };
}