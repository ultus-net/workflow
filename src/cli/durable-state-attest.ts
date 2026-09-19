#!/usr/bin/env node
import { resolve } from "node:path";

import { defaultProjectMemoryDataRoot } from "../integrations/project-memory.js";
import { attestProjectMemory, defaultAttestationPolicy, formatAttestationReport } from "../integrations/durable-state-attestation.js";

/**
 * Operator/monitor surface for W054 startup attestation. Read-only and
 * advisory: it reports durable-state provenance findings and exits non-zero
 * when flagged so scripts can notice, but it never mutates durable state.
 */
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const workspaceRoot = resolve(option("--workspace") ?? process.cwd());
const dataRoot = option("--data-dir") ?? defaultProjectMemoryDataRoot();
const attestation = await attestProjectMemory({
  dataRoot,
  workspaceRoot,
  policy: defaultAttestationPolicy(process.env),
});

console.log(formatAttestationReport(attestation));
console.log(`workspace: ${workspaceRoot}`);
console.log(`data root: ${dataRoot}`);
console.log(attestation.flagged
  ? "verdict: FLAGGED (advisory — inspect the findings above; nothing was auto-mutated)"
  : "verdict: clean");
if (attestation.flagged) process.exitCode = 1;