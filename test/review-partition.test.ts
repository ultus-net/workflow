import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveReviewCoverageManifest } from "../src/review/manifest.js";
import {
  BASELINE_REVIEW_RULES,
  INTEGRATION_REVIEW_RULES,
  MAX_REVIEW_UNIT_FILES,
  partitionPreservesManifest,
  partitionReviewManifest,
  renderIntegrationUnitText,
  renderReviewPartitionText,
  renderReviewUnitText,
  REVIEW_FOCUS_RULES,
} from "../src/review/partition.js";

/**
 * W040 — risk-aware review partitioning and rule matching. Grouping is
 * deterministic (implementation/tests/configuration of one component
 * together), focused rules attach per unit risk, an integration unit covers
 * cross-unit behavior, and the W039 manifest is never diluted:
 * partitionPreservesManifest is the invariant the tests pin.
 */

const MIXED_STATUS = [
  "M  src/kernel/task-graph.ts",
  "M  src/application/persistence.ts",
  "M  src/integrations/hub-reviewer.ts",
  "M  test/hub-reviewer.test.ts",
  "M  src/ui/web.ts",
  "?? src/new-toplevel.ts",
  "M  docs/FEATURES.md",
  "?? test/unpaired-thing.test.ts",
  "M  scripts/build.mjs",
  "M  package.json",
].join("\0");

function mixedManifest() {
  return deriveReviewCoverageManifest({ statusOutput: MIXED_STATUS });
}

test("implementation, tests, docs, scripts, and root files group into deterministic component units", () => {
  const partition = partitionReviewManifest(mixedManifest());
  assert.deepEqual(
    partition.units.map((unit) => `${unit.id}:${unit.paths.length}`),
    [
      "docs:1",
      "root:1",
      "scripts:1",
      "src:1",
      "src/application:1",
      "src/integrations:2",
      "src/kernel:1",
      "src/ui:1",
      "test:1",
    ],
  );
  // The hub-reviewer test pairs with its src module by basename stem.
  const integrations = partition.units.find((unit) => unit.id === "src/integrations");
  assert.deepEqual(integrations?.paths, ["src/integrations/hub-reviewer.ts", "test/hub-reviewer.test.ts"]);
  // Unpaired tests form their own unit instead of being dropped or forced.
  const testUnit = partition.units.find((unit) => unit.id === "test");
  assert.deepEqual(testUnit?.paths, ["test/unpaired-thing.test.ts"]);
  // Root files (no top-level directory) form the root unit.
  assert.deepEqual(partition.units.find((unit) => unit.id === "root")?.paths, ["package.json"]);
});

test("focused rules attach per risk without injecting every rule into every unit", () => {
  const partition = partitionReviewManifest(mixedManifest());
  const kernel = partition.units.find((unit) => unit.id === "src/kernel");
  const ui = partition.units.find((unit) => unit.id === "src/ui");
  const persistence = partition.units.find((unit) => unit.id === "src/application");
  const docs = partition.units.find((unit) => unit.id === "docs");

  for (const unit of [kernel, ui, persistence, docs]) {
    // Baseline rules are always present; each unit carries only its own focus.
    assert.ok(unit!.rules.length >= BASELINE_REVIEW_RULES.length);
    assert.deepEqual(unit!.rules.slice(0, BASELINE_REVIEW_RULES.length), BASELINE_REVIEW_RULES);
  }
  assert.ok(kernel!.rules.includes(REVIEW_FOCUS_RULES.authority[0]!));
  assert.ok(!kernel!.rules.includes(REVIEW_FOCUS_RULES.ui[0]!));
  assert.ok(!kernel!.rules.includes(REVIEW_FOCUS_RULES.persistence[0]!));
  assert.ok(ui!.risks.includes("ui"));
  assert.ok(ui!.rules.includes(REVIEW_FOCUS_RULES.ui[0]!));
  assert.ok(!ui!.rules.includes(REVIEW_FOCUS_RULES.security[0]!));
  assert.ok(persistence!.risks.includes("persistence"));
  assert.ok(persistence!.rules.includes(REVIEW_FOCUS_RULES.persistence[0]!));
  assert.ok(docs!.rules.includes(REVIEW_FOCUS_RULES.docs[0]!));
  assert.ok(!docs!.rules.includes(REVIEW_FOCUS_RULES.tests[0]!));
});

test("an integration unit exists exactly when more than one unit exists and carries no files", () => {
  const partition = partitionReviewManifest(mixedManifest());
  assert.ok(partition.units.length > 1);
  assert.equal(partition.integration?.id, "integration");
  assert.deepEqual(partition.integration?.paths, []);
  assert.deepEqual(partition.integration?.rules, [...BASELINE_REVIEW_RULES, ...INTEGRATION_REVIEW_RULES]);

  const single = partitionReviewManifest(deriveReviewCoverageManifest({ statusOutput: "M  src/a.ts\0?? src/b.ts\0" }));
  assert.equal(single.units.length, 1);
  assert.equal(single.integration, undefined);

  const empty = partitionReviewManifest(deriveReviewCoverageManifest({ statusOutput: "" }));
  assert.equal(empty.units.length, 0);
  assert.equal(empty.integration, undefined);
});

test("large components split deterministically at the unit cap without dropping scope", () => {
  const records: string[] = [];
  for (let index = 0; index < 30; index += 1) {
    records.push(`M  src/generated/file-${String(index).padStart(2, "0")}.ts`);
  }
  const manifest = deriveReviewCoverageManifest({ statusOutput: records.join("\0") });
  const partition = partitionReviewManifest(manifest);

  assert.equal(MAX_REVIEW_UNIT_FILES, 12);
  assert.deepEqual(
    partition.units.map((unit) => `${unit.id}:${unit.paths.length}`),
    ["src/generated:12", "src/generated~2:12", "src/generated~3:6"],
  );
  // Sorted chunks: the first chunk is the lexicographically first files.
  assert.equal(partition.units[0]?.paths[0], "src/generated/file-00.ts");
  assert.equal(partition.units[2]?.paths[5], "src/generated/file-29.ts");
  assert.ok(partitionPreservesManifest(partition, manifest));
});

test("partitionPreservesManifest holds and detects tampering", () => {
  const manifest = mixedManifest();
  const partition = partitionReviewManifest(manifest);
  assert.ok(partitionPreservesManifest(partition, manifest));

  // Dropping a unit's file breaks the invariant.
  const dropped: typeof partition = {
    ...partition,
    units: partition.units.slice(1),
    integration: undefined,
  };
  assert.equal(partitionPreservesManifest(dropped, manifest), false);

  // An integration unit that carries files breaks the invariant.
  const integrated: typeof partition = {
    ...partition,
    integration: { ...partition.integration!, paths: ["package.json"] },
  };
  assert.equal(partitionPreservesManifest(integrated, manifest), false);

  // Diluting a unit's obligations below its entries' breaks the invariant.
  const diluted: typeof partition = {
    ...partition,
    units: partition.units.map((unit) =>
      unit.id === "src/kernel" ? { ...unit, obligations: unit.obligations.filter((o) => o !== "authority") } : unit,
    ),
  };
  assert.equal(partitionPreservesManifest(diluted, manifest), false);

  // A manifest that gained a file the partition never saw breaks the invariant.
  const grown = deriveReviewCoverageManifest({ statusOutput: `${MIXED_STATUS}\0M  src/kernel/extra.ts\0` });
  assert.equal(partitionPreservesManifest(partition, grown), false);

  // Empty manifests are preserved vacuously.
  const emptyManifest = deriveReviewCoverageManifest({ statusOutput: "" });
  assert.ok(partitionPreservesManifest(partitionReviewManifest(emptyManifest), emptyManifest));
});

test("partitioning is deterministic: input order and repetition yield identical digests", () => {
  const left = partitionReviewManifest(mixedManifest());
  const reversedStatus = [...MIXED_STATUS.split("\0")].reverse().join("\0");
  const right = partitionReviewManifest(deriveReviewCoverageManifest({ statusOutput: reversedStatus }));
  assert.equal(left.digest, right.digest);
  assert.match(left.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(left.units.map((unit) => unit.id), right.units.map((unit) => unit.id));

  const changed = partitionReviewManifest(
    deriveReviewCoverageManifest({ statusOutput: `${MIXED_STATUS}\0?? src/extra.ts\0` }),
  );
  assert.notEqual(changed.digest, left.digest);
});

test("unit and integration renderings are deterministic prompt facts", () => {
  const partition = partitionReviewManifest(mixedManifest());
  const integrations = partition.units.find((unit) => unit.id === "src/integrations")!;

  const unitText = renderReviewUnitText(integrations);
  assert.ok(unitText.includes("Review unit `src/integrations` — 2 file(s)"));
  assert.ok(unitText.includes("- src/integrations/hub-reviewer.ts"));
  assert.ok(unitText.includes("- test/hub-reviewer.test.ts"));
  assert.ok(unitText.includes("[COVERAGE]"));

  const integrationText = renderIntegrationUnitText(partition);
  for (const unit of partition.units) {
    assert.ok(integrationText.includes(`- ${unit.id} (`), `integration lists unit ${unit.id}`);
  }
  assert.ok(integrationText.includes("End your final message with `[COVERAGE] `"));

  const overview = renderReviewPartitionText(partition);
  assert.ok(overview.includes(`${partition.units.length} review unit(s):`));
  assert.ok(overview.includes("Integration unit covers cross-unit behavior."));
  assert.equal(renderReviewPartitionText(partitionReviewManifest(deriveReviewCoverageManifest({ statusOutput: "" }))), "No changed or untracked files are in scope for this review.");
});

test("a large manifest partitions completely with the preservation invariant intact", () => {
  const records: string[] = [];
  for (let index = 0; index < 200; index += 1) {
    records.push(`M  src/kernel/gen-${index}.ts`);
    records.push(`?? src/ui/gen-${index}.tsx`);
    records.push(`M  test/gen-${index}.test.ts`);
  }
  const manifest = deriveReviewCoverageManifest({ statusOutput: records.join("\0") });
  const partition = partitionReviewManifest(manifest);

  // Each test/gen-N.test.ts pairs (basename stem) with both src files; the
  // deterministic rule picks the first sorted component, so all 200 tests join
  // src/kernel: 400 entries there and 200 in src/ui.
  const kernelFiles = Math.ceil(400 / MAX_REVIEW_UNIT_FILES);
  const uiFiles = Math.ceil(200 / MAX_REVIEW_UNIT_FILES);
  assert.equal(partition.units.length, kernelFiles + uiFiles);
  assert.ok(partitionPreservesManifest(partition, manifest));
  assert.equal(partition.units.reduce((total, unit) => total + unit.paths.length, 0), manifest.entries.length);
});
