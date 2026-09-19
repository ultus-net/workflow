import { join } from "node:path";

import { APPS } from "./apps.js";
import { byteLength, listCatalog, schemaBytes, serializeCatalog, toolIndexBytes } from "./catalog.js";
import { findWorkspaceRoot } from "./paths.js";

/**
 * Token-economy measurement at the MCP boundary.
 *
 * Primary metric per the accepted P702A decision: exact serialized `tools/list`
 * bytes (host-neutral, deterministic). The progressive-discovery delta is the
 * difference between the full catalog and the compact host-side tool index a
 * host can inject before loading definitions.
 */

export interface AppMeasurement {
  readonly app: string;
  readonly tools: number;
  readonly catalogBytes: number;
  readonly inputSchemaBytes: number;
  readonly outputSchemaBytes: number;
  readonly toolIndexBytes: number;
  readonly savingsBytes: number;
  readonly savingsPercent: number;
}

export interface PortfolioMeasurement {
  readonly apps: readonly AppMeasurement[];
  readonly totals: {
    readonly apps: number;
    readonly tools: number;
    readonly catalogBytes: number;
    readonly inputSchemaBytes: number;
    readonly outputSchemaBytes: number;
    readonly toolIndexBytes: number;
    readonly savingsBytes: number;
    readonly savingsPercent: number;
  };
}

export async function measureApp(appId: string, workspaceRoot: string): Promise<AppMeasurement> {
  const appDir = join(workspaceRoot, "apps", appId);
  const catalog = await listCatalog(appDir);
  const catalogBytes = byteLength(serializeCatalog(catalog));
  const schemas = schemaBytes(catalog);
  const indexBytes = toolIndexBytes(catalog);
  const savingsBytes = catalogBytes - indexBytes;
  return {
    app: appId,
    tools: catalog.tools.length,
    catalogBytes,
    inputSchemaBytes: schemas.input,
    outputSchemaBytes: schemas.output,
    toolIndexBytes: indexBytes,
    savingsBytes,
    savingsPercent: catalogBytes === 0 ? 0 : Math.round((savingsBytes / catalogBytes) * 1000) / 10,
  };
}

export async function measurePortfolio(workspaceRoot: string = findWorkspaceRoot()): Promise<PortfolioMeasurement> {
  const apps: AppMeasurement[] = [];
  for (const app of APPS) apps.push(await measureApp(app.id, workspaceRoot));
  const totals = apps.reduce(
    (acc, entry) => ({
      apps: acc.apps + 1,
      tools: acc.tools + entry.tools,
      catalogBytes: acc.catalogBytes + entry.catalogBytes,
      inputSchemaBytes: acc.inputSchemaBytes + entry.inputSchemaBytes,
      outputSchemaBytes: acc.outputSchemaBytes + entry.outputSchemaBytes,
      toolIndexBytes: acc.toolIndexBytes + entry.toolIndexBytes,
      savingsBytes: acc.savingsBytes + entry.savingsBytes,
    }),
    { apps: 0, tools: 0, catalogBytes: 0, inputSchemaBytes: 0, outputSchemaBytes: 0, toolIndexBytes: 0, savingsBytes: 0 },
  );
  return {
    apps,
    totals: {
      ...totals,
      savingsPercent: totals.catalogBytes === 0 ? 0 : Math.round((totals.savingsBytes / totals.catalogBytes) * 1000) / 10,
    },
  };
}

export function formatMeasurement(measurement: PortfolioMeasurement): string {
  const lines = [
    "app                               tools  catalog  in-schema  out-schema  index  savings",
  ];
  for (const entry of measurement.apps) {
    lines.push(
      `${entry.app.padEnd(33)} ${String(entry.tools).padStart(5)} ${String(entry.catalogBytes).padStart(8)} ${String(entry.inputSchemaBytes).padStart(10)} ${String(entry.outputSchemaBytes).padStart(11)} ${String(entry.toolIndexBytes).padStart(6)} ${String(entry.savingsPercent).padStart(7)}%`,
    );
  }
  const total = measurement.totals;
  lines.push(
    `${"TOTAL".padEnd(33)} ${String(total.tools).padStart(5)} ${String(total.catalogBytes).padStart(8)} ${String(total.inputSchemaBytes).padStart(10)} ${String(total.outputSchemaBytes).padStart(11)} ${String(total.toolIndexBytes).padStart(6)} ${String(total.savingsPercent).padStart(7)}%`,
  );
  return lines.join("\n");
}