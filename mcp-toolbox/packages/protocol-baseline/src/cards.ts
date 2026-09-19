import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { APPS, findApp, type AppDescriptor } from "./apps.js";
import { buildToolIndex, cardFile, listCatalog, toolIndexBytes, type ToolIndexEntry } from "./catalog.js";
import { findWorkspaceRoot, readPackageManifest } from "./paths.js";
import { SPEC_VERSION, SURVEY_DATE } from "./spec.js";

/**
 * First-party Server Card for the (not-yet-shipped-in-SDK) Server Card WG
 * `.well-known` convention. Every field is derived from exactly two sources:
 * the product's `package.json` and its compiled `tools/list` response. There
 * is no hand-maintained duplication — `cards:generate` rewrites the artifact
 * and the drift test in `test/cards.test.ts` fails when it is stale.
 */

export const SERVER_CARD_SCHEMA = "https://modelcontextprotocol.io/schemas/server-card/2026-07-28";

const ToolIndexEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  readOnly: z.boolean().optional(),
  taskSupport: z.string().optional(),
});

export const ServerCardSchema = z.object({
  schema: z.literal(SERVER_CARD_SCHEMA),
  schemaVersion: z.literal("1"),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  protocolVersion: z.literal(SPEC_VERSION),
  transport: z.literal("stdio"),
  capabilities: z.record(z.string(), z.unknown()),
  tools: z.array(ToolIndexEntrySchema),
  discovery: z.object({
    strategy: z.literal("host-side-progressive"),
    note: z.string(),
    fullCatalogBytes: z.number().int().nonnegative(),
    toolIndexBytes: z.number().int().nonnegative(),
  }),
  generatedBy: z.literal("@agent-tools/protocol-baseline"),
  surveyedAt: z.literal(SURVEY_DATE),
});

export type ServerCard = z.infer<typeof ServerCardSchema>;

export interface GeneratedCard {
  readonly app: AppDescriptor;
  readonly appDir: string;
  readonly card: ServerCard;
  readonly serialized: string;
}

const PROGRESSIVE_NOTE =
  "Complete, stable tools/list is always served. This card carries a compact index " +
  "(names, descriptions, risk hints) for hosts that progressively disclose model-visible " +
  "definitions; tool definitions are never made connection-local or model-use-dependent.";

export async function buildCard(app: AppDescriptor, workspaceRoot: string = findWorkspaceRoot()): Promise<GeneratedCard> {
  const appDir = join(workspaceRoot, "apps", app.id);
  const manifest = readPackageManifest(appDir);
  const catalog = await listCatalog(appDir);
  const toolIndex = buildToolIndex(catalog);
  const card = ServerCardSchema.parse({
    schema: SERVER_CARD_SCHEMA,
    schemaVersion: "1",
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    protocolVersion: SPEC_VERSION,
    transport: "stdio",
    capabilities: catalog.capabilities as Record<string, unknown>,
    tools: toolIndex as ToolIndexEntry[],
    discovery: {
      strategy: "host-side-progressive",
      note: PROGRESSIVE_NOTE,
      fullCatalogBytes: Buffer.byteLength(JSON.stringify({ tools: catalog.tools }), "utf8"),
      toolIndexBytes: toolIndexBytes(catalog),
    },
    generatedBy: "@agent-tools/protocol-baseline",
    surveyedAt: SURVEY_DATE,
  });
  return { app, appDir, card, serialized: serializeCard(card) };
}

/** Stable formatting: pretty JSON with a trailing newline. */
export function serializeCard(card: ServerCard): string {
  return `${JSON.stringify(card, null, 2)}\n`;
}

export async function buildAllCards(workspaceRoot: string = findWorkspaceRoot()): Promise<readonly GeneratedCard[]> {
  const cards: GeneratedCard[] = [];
  for (const app of APPS) cards.push(await buildCard(app, workspaceRoot));
  return cards;
}

export async function writeAllCards(workspaceRoot: string = findWorkspaceRoot()): Promise<readonly GeneratedCard[]> {
  const cards = await buildAllCards(workspaceRoot);
  for (const generated of cards) {
    await mkdir(cardFile(generated.appDir).replace(/\/server-card\.json$/u, ""), { recursive: true });
    await writeFile(cardFile(generated.appDir), generated.serialized, "utf8");
  }
  return cards;
}

export interface CardDrift {
  readonly app: string;
  readonly status: "current" | "missing" | "stale";
}

export function readCommittedCard(appDir: string): string | undefined {
  const file = cardFile(appDir);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8");
}

export async function checkAllCards(workspaceRoot: string = findWorkspaceRoot()): Promise<readonly CardDrift[]> {
  const drifts: CardDrift[] = [];
  for (const app of APPS) {
    const generated = await buildCard(app, workspaceRoot);
    const committed = readCommittedCard(generated.appDir);
    if (committed === undefined) drifts.push({ app: app.id, status: "missing" });
    else if (committed !== generated.serialized) drifts.push({ app: app.id, status: "stale" });
    else drifts.push({ app: app.id, status: "current" });
  }
  return drifts;
}

export function validateCard(value: unknown): ServerCard {
  return ServerCardSchema.parse(value);
}

export { findApp };