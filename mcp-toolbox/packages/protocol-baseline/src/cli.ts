#!/usr/bin/env node
import { checkAllCards, writeAllCards } from "./cards.js";
import { conformanceSummary, runConformance } from "./conformance.js";
import { formatMeasurement, measurePortfolio } from "./measure.js";
import { findWorkspaceRoot } from "./paths.js";
import { FEATURE_SURVEY, SURVEY_DATE, surveySummary } from "./spec.js";

const USAGE = `protocol-baseline <command>

Commands:
  generate-cards   Rewrite every product .well-known/server-card.json from its compiled tools/list.
  check-cards      Report missing/stale cards (exit 1 on drift).
  measure          Print the tools/list token-economy table including the progressive index delta.
  conformance      Run the MCP 2026-07-28 smoke against every product (exit 1 on failure).
  survey           Print the dated SDK feature survey.
`;

async function main(): Promise<void> {
  const command = process.argv[2];
  const root = findWorkspaceRoot();
  switch (command) {
    case "generate-cards": {
      const cards = await writeAllCards(root);
      console.log(`wrote ${cards.length} server cards`);
      return;
    }
    case "check-cards": {
      const drifts = await checkAllCards(root);
      for (const drift of drifts) console.log(`${drift.status.padEnd(8)} ${drift.app}`);
      const bad = drifts.filter((drift) => drift.status !== "current");
      if (bad.length > 0) {
        console.error(`${bad.length} card(s) missing or stale; run pnpm run cards:generate`);
        process.exitCode = 1;
      }
      return;
    }
    case "measure": {
      console.log(formatMeasurement(await measurePortfolio(root)));
      return;
    }
    case "conformance": {
      const reports = await runConformance(root);
      for (const report of reports) {
        console.log(`${report.passed ? "PASS" : "FAIL"} ${report.app}`);
        for (const check of report.checks) {
          console.log(`  ${check.passed ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
        }
      }
      const summary = conformanceSummary(reports);
      console.log(
        `\n${summary.passed}/${summary.apps} apps passed; SDK survey ${summary.spec.surveyDate}: ` +
          `${summary.spec.counts.native} native, ${summary.spec.counts.partial} partial, ${summary.spec.counts.absent} absent`,
      );
      if (summary.failed.length > 0) process.exitCode = 1;
      return;
    }
    case "survey": {
      const summary = surveySummary();
      console.log(`MCP ${summary.specVersion} SDK survey (${SURVEY_DATE})`);
      for (const feature of FEATURE_SURVEY) {
        console.log(`  [${feature.sdkSupport}] ${feature.id}: ${feature.title}`);
      }
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

await main();