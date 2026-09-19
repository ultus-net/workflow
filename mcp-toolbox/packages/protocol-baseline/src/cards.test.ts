import assert from "node:assert/strict";
import test from "node:test";

import { APPS } from "./apps.js";
import { checkAllCards, validateCard, SERVER_CARD_SCHEMA } from "./cards.js";
import { cardFile, listCatalog } from "./catalog.js";
import { findWorkspaceRoot } from "./paths.js";
import { readCommittedCard } from "./cards.js";

const root = findWorkspaceRoot();

test("every product ships a current, non-stale Server Card", async () => {
  const drifts = await checkAllCards(root);
  const offenders = drifts.filter((drift) => drift.status !== "current");
  assert.deepEqual(
    offenders,
    [],
    `stale/missing cards: ${offenders.map((drift) => `${drift.app}=${drift.status}`).join(", ")}; run pnpm run cards:generate`,
  );
});

test("every committed card validates and matches its compiled catalog", async () => {
  for (const app of APPS) {
    const appDir = `${root}/apps/${app.id}`;
    const committed = readCommittedCard(appDir);
    assert.ok(committed, `${app.id} has no committed card at ${cardFile(appDir)}`);
    const card = validateCard(JSON.parse(committed));
    assert.equal(card.schema, SERVER_CARD_SCHEMA);
    assert.equal(card.protocolVersion, "2026-07-28");
    const catalog = await listCatalog(appDir);
    assert.deepEqual(
      card.tools.map((tool) => tool.name),
      catalog.tools.map((tool) => tool.name),
      `${app.id} card tool list drifted from tools/list`,
    );
  }
});

test("cards are generated from a single source of truth (no hand-maintained tool list)", async () => {
  const committed = readCommittedCard(`${root}/apps/workflow-guard-mcp`);
  assert.ok(committed !== undefined);
  assert.ok(committed.includes("@agent-tools/protocol-baseline"));
  assert.ok(committed.includes("host-side-progressive"));
});