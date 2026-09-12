#!/usr/bin/env node
import { hostCapabilities } from "../adapters/host.js";
import { WorkflowApplication } from "../application/workflow.js";
import { createConfiguredClineRuntime } from "../integrations/cline-runtime.js";
import { resolveStyleFromEnv, type SessionStyle } from "../integrations/response-style.js";
import { taskId, type WorkflowTask } from "../kernel/contracts.js";
import { TaskGraph } from "../kernel/task-graph.js";

/**
 * Measures output-token deltas per response/build style on a fixed prompt.
 * N=1 per style — a smoke indicator, not a benchmark; model variance is high.
 * Usage: npm run style:eval -- "optional prompt override"
 */
const prompt = process.argv.slice(2).join(" ") ||
  "Implement the smallest possible fix for the typo in README and summarize the change.";

const tasks: WorkflowTask[] = [{ id: taskId("W001"), title: "Style eval", state: "BLOCKED", dependencies: [], requiredEvidence: [] }];
const workspace = process.cwd();
const application = new WorkflowApplication(
  new TaskGraph(tasks),
  hostCapabilities({ transport: "native", authoritativePreMutation: true }),
  [],
  new Set(["read", "mutation", "process"]),
  workspace,
);

const variants: readonly { label: string; style: SessionStyle }[] = [
  { label: "baseline (normal/normal)", style: { speech: "normal", build: "normal" } },
  { label: "caveman speech", style: { speech: "caveman", build: "normal" } },
  { label: "ponytail-lite", style: { speech: "normal", build: "ponytail-lite" } },
  { label: "ponytail-full", style: { speech: "normal", build: "ponytail-full" } },
  { label: "ponytail-ultra", style: { speech: "normal", build: "ponytail-ultra" } },
];

const runtime = await createConfiguredClineRuntime(application, workspace);
const session = runtime.session;
const baseEnv = resolveStyleFromEnv(process.env);

console.log(`style:eval — prompt: "${prompt}"\n`);
const rows: { label: string; inputTokens: number; outputTokens: number }[] = [];
for (const variant of variants) {
  runtime.setSessionStyle(variant.style);
  const before = session.driver.usageSnapshot?.() ?? { inputTokens: 0, outputTokens: 0 };
  await session.submit(prompt);
  const after = session.driver.usageSnapshot?.() ?? { inputTokens: 0, outputTokens: 0 };
  rows.push({
    label: variant.label,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
  });
}
await runtime.dispose();

const baseline = rows[0]!;
console.log("variant                    | input tokens | output tokens | output Δ vs baseline");
for (const row of rows) {
  const delta = baseline.outputTokens === 0 ? "n/a" : `${Math.round((1 - row.outputTokens / baseline.outputTokens) * 100)}%`;
  console.log(`${row.label.padEnd(26)} | ${String(row.inputTokens).padStart(12)} | ${String(row.outputTokens).padStart(13)} | ${delta}`);
}
console.log("\nCaveat: N=1 per style — variance is high. Default style unchanged: this eval does not mutate your env style.",
  `\n(resolved env style: speech=${baseEnv.speech}, build=${baseEnv.build})`);
