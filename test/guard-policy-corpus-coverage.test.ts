import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * C2 (mcp-toolbox → control-plane conversion) corpus-coverage drift guard.
 *
 * The vendored tree (`mcp-toolbox/vendor/opencode-workflow-guard/`) is the
 * PROVENANCE corpus of record, but it is NOT what runs: the operative guard is
 * the app port (`mcp-toolbox/apps/workflow-guard-mcp/src`), and the hub/seat
 * in-process copy (`src/integrations/guard-policy/`, byte-identical to the
 * port's portable modules, pinned by `test/guard-policy-drift.test.ts`). The
 * vendored tree is bound to nothing else at runtime, so this guard keeps the
 * three claims honest and executable:
 *
 *   1. every vendored `src/policies/*.ts` has a disposition in COVERAGE.json
 *      (a newly vendored policy cannot go unaccounted);
 *   2. every policy that names `modules` actually maps to those app-port
 *      files (a module rename/deletion cannot silently orphan a disposition);
 *   3. the SECURITY-RELEVANT lanes the corpus records stay honest in the
 *      direction they were recorded — pre-W214 (2026-10-17, residual #27)
 *      this pinned the three upstream enforcement lanes ABSENT from the port
 *      (fail-closed if ported without an inventory update); post-W214 the
 *      same mechanism pins them PORTED, so a silent regression removing a
 *      ported lane fails here too.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const vendoredPoliciesDir = join(repoRoot, "mcp-toolbox", "vendor", "opencode-workflow-guard", "src", "policies");
const appSrcDir = join(repoRoot, "mcp-toolbox", "apps", "workflow-guard-mcp", "src");
const coveragePath = join(repoRoot, "mcp-toolbox", "vendor", "opencode-workflow-guard", "COVERAGE.json");

interface PolicyDisposition {
  disposition: "ported" | "partial" | "host-owned" | "out-of-scope";
  modules: string[];
  missing?: string;
  note?: string;
}

const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as {
  dispositions: string[];
  policies: Record<string, PolicyDisposition>;
};

const vendoredPolicies = readdirSync(vendoredPoliciesDir).filter((name) => name.endsWith(".ts")).sort();

test("every vendored policy has a disposition in COVERAGE.json", () => {
  const unaccounted = vendoredPolicies.filter((name) => coverage.policies[name] === undefined);
  assert.deepEqual(
    unaccounted,
    [],
    `vendored policies with no COVERAGE.json disposition: ${unaccounted.join(", ")}; add each to mcp-toolbox/vendor/opencode-workflow-guard/COVERAGE.json`,
  );
  const stale = Object.keys(coverage.policies).filter((name) => !vendoredPolicies.includes(name)).sort();
  assert.deepEqual(stale, [], `COVERAGE.json lists policies no longer vendored: ${stale.join(", ")}`);
});

test("every disposition names a valid class and existing app-port modules", () => {
  for (const [policy, entry] of Object.entries(coverage.policies)) {
    assert.ok(coverage.dispositions.includes(entry.disposition), `${policy}: unknown disposition '${entry.disposition}'`);
    for (const module of entry.modules) {
      assert.ok(existsSync(join(appSrcDir, module)), `${policy}: disposition names '${module}', which does not exist in the app port`);
    }
    if (entry.disposition === "partial") {
      assert.ok((entry.missing ?? "").length > 0, `${policy}: a 'partial' disposition must state what is missing`);
    }
  }
});

// W214 (2026-10-17, residual #27, issues #539/#540/#541): the three upstream
// enforcement lanes the port once lacked are PORTED, named by their exported
// operator so the record is exact. Pre-W214 this block pinned the lanes
// ABSENT (fail-closed if any was ported without an inventory update); it now
// pins them PRESENT — a silent regression removing a ported lane is the same
// inventory lie in the other direction. The behavioral proof lives in
// mcp-toolbox/apps/workflow-guard-mcp/test/policy.test.ts (the W214 block).
const PORTED_SECURITY_LANES: ReadonlyArray<{ operator: string; vendored: string; vendoredFile: string }> = [
  { operator: "secretFileReadIn", vendored: "secrets", vendoredFile: "secrets.ts" },
  { operator: "liveMutationIn", vendored: "destructive", vendoredFile: "destructive.ts" },
  { operator: "extractEditContent", vendored: "destructive", vendoredFile: "destructive.ts" },
  { operator: "outsideWritePathInPayload", vendored: "interpreter", vendoredFile: "interpreter.ts" },
  { operator: "secretPathInPayload", vendored: "interpreter", vendoredFile: "interpreter.ts" },
];

test("the security-relevant lanes pinned as ported stay ported (ported corpus is honest)", () => {
  const appSource = readdirSync(appSrcDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(appSrcDir, name), "utf8"))
    .join("\n");
  for (const lane of PORTED_SECURITY_LANES) {
    // The operator must exist upstream (the corpus really carries the lane)...
    const vendoredSource = readFileSync(join(vendoredPoliciesDir, lane.vendoredFile), "utf8");
    assert.match(
      vendoredSource,
      new RegExp(`export function ${lane.operator}\\b`),
      `the vendored corpus no longer exports ${lane.operator}; re-vendor or update COVERAGE.json`,
    );
    // ...and must be present in the app port, with its disposition no longer
    // recording it as missing (the record of the port stays true).
    assert.ok(
      new RegExp(`\\b${lane.operator}\\b`).test(appSource),
      `app port no longer references '${lane.operator}': a ported security lane was silently removed. Restore it, or record the regression in COVERAGE.json + VENDOR.md + docs/SECURITY_ASSURANCE.md #27.`,
    );
    const entry = coverage.policies[`${lane.vendored}.ts`]!;
    if (entry.disposition === "partial") {
      assert.ok(
        !(entry.missing ?? "").includes(lane.operator),
        `${lane.vendored}.ts records '${lane.operator}' as missing, but the port carries it; update COVERAGE.json`,
      );
    }
  }
});
