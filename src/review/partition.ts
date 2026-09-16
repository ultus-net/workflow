/**
 * Risk-aware review partitioning and rule matching (TASKS.md W040).
 *
 * Large reviews stay complete and context-efficient: the W039 manifest is
 * deterministically grouped into isolated review units (implementation,
 * tests, and configuration of one component together), each unit receives
 * only its applicable focused rules — never every rule — and an integration
 * unit covers cross-unit behavior when more than one unit exists.
 *
 * The preservation invariant is the contract W040 owes W039: partitioning
 * never removes a file or obligation from the coverage manifest
 * (`partitionPreservesManifest` proves it, and the tests pin it).
 */

import { createHash } from "node:crypto";

import type { ReviewCoverageManifest, ReviewManifestEntry, ReviewObligation } from "./manifest.js";

/**
 * Risk classes drive focused rule matching. They extend the W039 obligation
 * table (which already carries security/authority/tests/docs) with the
 * persistence and UI classes W040 names; scope itself is never re-derived.
 */
export type ReviewRiskClass = ReviewObligation | "persistence" | "ui";

const RISK_ORDER: readonly ReviewRiskClass[] = ["security", "authority", "persistence", "ui", "tests", "docs", "general"];

/** Explicit path rules for the risk classes W040 adds on top of W039 obligations. */
export const REVIEW_RISK_RULES: readonly {
  readonly risk: Exclude<ReviewRiskClass, ReviewObligation>;
  readonly pattern: RegExp;
  readonly reason: string;
}[] = [
  { risk: "persistence", pattern: /^src\/application\/persistence\.ts$/, reason: "task/evidence persistence across restarts" },
  { risk: "persistence", pattern: /^src\/integrations\/run-registry\.ts$/, reason: "run journal and recovery semantics" },
  { risk: "ui", pattern: /^src\/ui\//, reason: "operator surface rendering and interaction" },
  { risk: "ui", pattern: /^src\/cli\//, reason: "operator entrypoints and surface composition" },
];

/** Baseline rules every unit receives (the five-axis essence). */
export const BASELINE_REVIEW_RULES: readonly string[] = [
  "Evaluate the change across the five axes: test integrity, task completeness, cleanliness, security, platform.",
  "Rank findings P0-P3; P0 and P1 findings must block approval.",
];

/** Focused rules attached only to units whose paths carry the risk class. */
export const REVIEW_FOCUS_RULES: Readonly<Record<Exclude<ReviewRiskClass, "general">, readonly string[]>> = {
  security: [
    "Verify every failure direction fails closed: deny, error, and unavailable paths must never promote a run or admit evidence.",
    "Verify containment, credential, and authorization boundaries are not weakened or bypassed.",
  ],
  authority: [
    "Verify task/evidence transitions remain legal kernel transitions and evidence admission stays deterministic.",
    "Verify no model/host/provider types or SDK concerns enter the kernel or application authority.",
  ],
  persistence: [
    "Verify persisted state and journals survive restart without trusting model summaries and recovery stays deterministic.",
  ],
  ui: [
    "Verify the surface renders canonical application state only and cannot bypass kernel decisions.",
    "Verify loading, error, empty, and denied states remain explicit and keyboard interaction is preserved.",
  ],
  tests: [
    "Verify assertions test real behavior and edge/error paths, and that no existing test was disabled or weakened.",
  ],
  docs: [
    "Verify every operator-facing claim matches the code, with limits stated plainly.",
  ],
};

export const INTEGRATION_REVIEW_RULES: readonly string[] = [
  "Verify the contracts and composition BETWEEN the changed units below: cross-unit assumptions, import direction, and shared types.",
  "Verify no unit's change invalidates another unit's behavior or its focused rules.",
];

export interface ReviewUnit {
  /** Stable unit id: the component, or `<component>~<n>` when a cap split occurred. */
  readonly id: string;
  /** Manifest paths in this unit; empty for the integration unit. */
  readonly paths: readonly string[];
  /** Union of the W039 obligations carried by this unit's entries. */
  readonly obligations: readonly ReviewObligation[];
  readonly risks: readonly ReviewRiskClass[];
  /** Baseline rules plus the focused rules for this unit's risks, in deterministic order. */
  readonly rules: readonly string[];
  readonly isIntegration: boolean;
}

export interface ReviewPartition {
  /** File-bearing units, sorted by id. */
  readonly units: readonly ReviewUnit[];
  /** Present iff more than one unit exists; carries no files, only cross-unit scope. */
  readonly integration: ReviewUnit | undefined;
  /** Stable sha256 binding the partition to its manifest digest and unit shape. */
  readonly digest: string;
}

/** Units larger than this are split deterministically to keep reviewer context bounded. */
export const MAX_REVIEW_UNIT_FILES = 12;

const OBLIGATION_ORDER: readonly ReviewObligation[] = ["security", "authority", "tests", "docs", "general"];

function reviewRisksForEntry(entry: ReviewManifestEntry): readonly ReviewRiskClass[] {
  const risks = new Set<ReviewRiskClass>(entry.obligations);
  for (const rule of REVIEW_RISK_RULES) {
    if (rule.pattern.test(entry.path)) risks.add(rule.risk);
  }
  return RISK_ORDER.filter((risk) => risks.has(risk));
}

function basename(path: string): string {
  const segment = path.slice(path.lastIndexOf("/") + 1);
  const dot = segment.lastIndexOf(".");
  return dot <= 0 ? segment : segment.slice(0, dot);
}

/**
 * Deterministic component for a manifest path. Tests pair with the src
 * module that shares their basename stem; docs share one component; anything
 * else groups by top-level directory (root files form "root").
 */
function componentForPath(path: string, entries: readonly ReviewManifestEntry[]): string {
  if (path.startsWith("test/")) {
    const stem = basename(path.replace(/\.test\.tsx?$/, ""));
    const match = entries
      .filter((entry) => entry.path.startsWith("src/") && basename(entry.path) === stem)
      .map((entry) => componentForPath(entry.path, entries))
      .sort()[0];
    return match ?? "test";
  }
  const srcLayer = /^src\/([^/]+)\//.exec(path);
  if (srcLayer) return `src/${srcLayer[1]}`;
  if (path.startsWith("src/")) return "src";
  if (path.startsWith("docs/") || path.endsWith(".md")) return "docs";
  const slash = path.indexOf("/");
  return slash === -1 ? "root" : path.slice(0, slash);
}

function rulesForRisks(risks: readonly ReviewRiskClass[]): readonly string[] {
  const focused = RISK_ORDER.filter((risk): risk is Exclude<ReviewRiskClass, "general"> => risk !== "general" && risks.includes(risk))
    .flatMap((risk) => REVIEW_FOCUS_RULES[risk]);
  return [...BASELINE_REVIEW_RULES, ...focused];
}

function unitFromGroup(id: string, entries: readonly ReviewManifestEntry[], isIntegration: boolean): ReviewUnit {
  const obligations = new Set<ReviewObligation>();
  const risks = new Set<ReviewRiskClass>();
  for (const entry of entries) {
    for (const obligation of entry.obligations) obligations.add(obligation);
    for (const risk of reviewRisksForEntry(entry)) risks.add(risk);
  }
  if (isIntegration) {
    return {
      id,
      paths: [],
      obligations: OBLIGATION_ORDER.filter((obligation) => obligations.has(obligation)),
      risks: RISK_ORDER.filter((risk) => risks.has(risk)),
      rules: [...BASELINE_REVIEW_RULES, ...INTEGRATION_REVIEW_RULES],
      isIntegration: true,
    };
  }
  const unitRisks = RISK_ORDER.filter((risk) => risks.has(risk));
  return {
    id,
    paths: entries.map((entry) => entry.path),
    obligations: OBLIGATION_ORDER.filter((obligation) => obligations.has(obligation)),
    risks: unitRisks,
    rules: rulesForRisks(unitRisks),
    isIntegration: false,
  };
}

export function partitionReviewManifest(manifest: ReviewCoverageManifest): ReviewPartition {
  const byComponent = new Map<string, ReviewManifestEntry[]>();
  for (const entry of manifest.entries) {
    const component = componentForPath(entry.path, manifest.entries);
    const group = byComponent.get(component) ?? [];
    group.push(entry);
    byComponent.set(component, group);
  }
  const units: ReviewUnit[] = [];
  for (const component of [...byComponent.keys()].sort()) {
    const entries = (byComponent.get(component) ?? []).slice().sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    for (let index = 0; index < entries.length; index += MAX_REVIEW_UNIT_FILES) {
      const chunk = entries.slice(index, index + MAX_REVIEW_UNIT_FILES);
      // The first chunk keeps the plain component id; later chunks get ~2, ~3, ...
      const id = index === 0 ? component : `${component}~${Math.floor(index / MAX_REVIEW_UNIT_FILES) + 1}`;
      units.push(unitFromGroup(id, chunk, false));
    }
  }
  const integration = units.length > 1 ? integrationUnit(units) : undefined;
  return { units, integration, digest: partitionDigest(manifest, units, integration) };
}

function integrationUnit(units: readonly ReviewUnit[]): ReviewUnit {
  const obligations = new Set<ReviewObligation>();
  const risks = new Set<ReviewRiskClass>();
  for (const unit of units) {
    for (const obligation of unit.obligations) obligations.add(obligation);
    for (const risk of unit.risks) risks.add(risk);
  }
  return {
    id: "integration",
    paths: [],
    obligations: OBLIGATION_ORDER.filter((obligation) => obligations.has(obligation)),
    risks: RISK_ORDER.filter((risk) => risks.has(risk)),
    rules: [...BASELINE_REVIEW_RULES, ...INTEGRATION_REVIEW_RULES],
    isIntegration: true,
  };
}

function partitionDigest(manifest: ReviewCoverageManifest, units: readonly ReviewUnit[], integration: ReviewUnit | undefined): string {
  const canonical = [
    manifest.digest,
    ...units.map((unit) => [unit.id, unit.paths.join("+"), unit.obligations.join("+"), unit.risks.join("+")].join("\t")),
    ...(integration === undefined ? [] : [[integration.id, integration.obligations.join("+"), integration.risks.join("+")].join("\t")]),
  ].join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The W040 preservation invariant: every manifest file appears in exactly
 * one unit with its obligations preserved, and the integration unit carries
 * no files. Partitioning may split or group, never drop or dilute.
 */
export function partitionPreservesManifest(
  partition: ReviewPartition,
  manifest: ReviewCoverageManifest,
): boolean {
  const unitPaths = partition.units.flatMap((unit) => unit.paths).slice().sort();
  const manifestPaths = manifest.entries.map((entry) => entry.path).slice().sort();
  if (unitPaths.length !== manifestPaths.length) return false;
  for (let index = 0; index < unitPaths.length; index += 1) {
    if (unitPaths[index] !== manifestPaths[index]) return false;
  }
  const obligationsByPath = new Map(partition.units.flatMap((unit) => unit.paths.map((path) => [path, unit] as const)));
  for (const entry of manifest.entries) {
    const unit = obligationsByPath.get(entry.path);
    if (unit === undefined) return false;
    for (const obligation of entry.obligations) {
      if (!unit.obligations.includes(obligation)) return false;
    }
  }
  return partition.integration === undefined || partition.integration.paths.length === 0;
}

/** Prompt rendering for one file-bearing review unit. */
export function renderReviewUnitText(unit: ReviewUnit): string {
  const lines = [
    `Review unit \`${unit.id}\` — ${unit.paths.length} file(s), obligations: ${unit.obligations.join(", ")}`,
    "Paths in this unit (all are mandatory scope):",
    ...unit.paths.map((path) => `- ${path}`),
    "Focused rules for this unit:",
    ...unit.rules.map((rule) => `- ${rule}`),
    "End your final message with `[COVERAGE] ` followed by the unit's paths, comma-separated.",
  ];
  return lines.join("\n");
}

/** Prompt rendering for the cross-unit integration review. */
export function renderIntegrationUnitText(partition: ReviewPartition): string {
  const integration = partition.integration;
  if (integration === undefined) return "";
  const lines = [
    `Integration review — cross-unit behavior for ${partition.units.length} units:`,
    ...partition.units.map((unit) => `- ${unit.id} (${unit.risks.join(", ")})`),
    "Focused rules for this review:",
    ...integration.rules.map((rule) => `- ${rule}`),
    "End your final message with `[COVERAGE] ` followed by every unit id above, comma-separated.",
  ];
  return lines.join("\n");
}

/** Compact overview rendering for summaries and observability. */
export function renderReviewPartitionText(partition: ReviewPartition): string {
  if (partition.units.length === 0) return "No changed or untracked files are in scope for this review.";
  const units = partition.units
    .map((unit) => `- ${unit.id}: ${unit.paths.length} file(s) [${unit.risks.join(", ")}]`)
    .join("\n");
  const integration = partition.integration === undefined ? "" : `\nIntegration unit covers cross-unit behavior.`;
  return `${partition.units.length} review unit(s):\n${units}${integration}`;
}
