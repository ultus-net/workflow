import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { cleanEnv } from "./paths.js";

/** A tool as it crosses the MCP boundary in a `tools/list` response. */
export interface CatalogTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  readonly execution?: { readonly taskSupport?: string };
}

export interface Catalog {
  readonly appDir: string;
  readonly tools: readonly CatalogTool[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly serverInfo: { readonly name?: string; readonly version?: string };
}

export interface ListCatalogOptions {
  /** Extra environment for the server process (e.g. fixture directories). */
  readonly env?: Record<string, string>;
}

/**
 * Launch a compiled product and read its `tools/list` response through the
 * real MCP stdio boundary. This is the only place a catalog is materialized:
 * cards, measurements, and conformance all consume this function.
 */
export async function listCatalog(appDir: string, options: ListCatalogOptions = {}): Promise<Catalog> {
  const client = new Client({ name: "protocol-baseline", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: appDir,
    stderr: "pipe",
    env: cleanEnv(options.env ?? {}),
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const capabilities = (client.getServerCapabilities() ?? {}) as Readonly<Record<string, unknown>>;
    const version = client.getServerVersion();
    const serverInfo = version === undefined ? {} : { name: version.name, version: version.version };
    return { appDir, tools: tools as readonly CatalogTool[], capabilities, serverInfo };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Compact serialization of a list response, matching the P702A metric. */
export function serializeCatalog(catalog: Catalog): string {
  return JSON.stringify({ tools: catalog.tools });
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Input/output schema bytes, compact-serialized, summed across tools. */
export function schemaBytes(catalog: Catalog): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const tool of catalog.tools) {
    input += tool.inputSchema === undefined ? 0 : byteLength(compactJson(tool.inputSchema));
    output += tool.outputSchema === undefined ? 0 : byteLength(compactJson(tool.outputSchema));
  }
  return { input, output };
}

/**
 * The compact index a host can inject for progressive disclosure: tool names,
 * one-line descriptions, and the two risk hints a host needs to decide what to
 * load. It intentionally omits both schemas.
 */
export interface ToolIndexEntry {
  readonly name: string;
  readonly description?: string;
  readonly readOnly?: boolean;
  readonly taskSupport?: string;
}

export function buildToolIndex(catalog: Catalog): readonly ToolIndexEntry[] {
  return catalog.tools.map((tool) => {
    const entry: {
      name: string;
      description?: string;
      readOnly?: boolean;
      taskSupport?: string;
    } = { name: tool.name };
    if (tool.description !== undefined) entry.description = tool.description;
    if (tool.annotations?.readOnlyHint !== undefined) entry.readOnly = tool.annotations.readOnlyHint;
    if (tool.execution?.taskSupport !== undefined) entry.taskSupport = tool.execution.taskSupport;
    return entry;
  });
}

export function toolIndexBytes(catalog: Catalog): number {
  return byteLength(compactJson(buildToolIndex(catalog)));
}

/** Directory that owns a product's generated Server Card. */
export function cardDirectory(appDir: string): string {
  return join(appDir, ".well-known");
}

export function cardFile(appDir: string): string {
  return join(cardDirectory(appDir), "server-card.json");
}