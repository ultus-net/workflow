/**
 * Bumps the pinned Cline CLI tag in build-cline-tui.mjs to the latest
 * cli-v* tag from GitHub, then verifies the Workflow patch still applies
 * against that tag. Fails loudly when the patch no longer applies — that
 * means the patch needs human review against the new upstream source.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = resolve(root, "scripts", "build-cline-tui.mjs");
const patchPath = resolve(root, "patches", "cline-cli-v3.0.61-workflow.patch");

const current = readFileSync(buildScript, "utf8").match(/cli-v([\d.]+)/)?.[1];
if (!current) throw new Error("could not read current Cline pin from build script");

const tags = execFileSync("git", ["ls-remote", "--tags", "https://github.com/cline/cline.git", "refs/tags/cli-v*"], { encoding: "utf8" })
  .split("\n")
  .map((line) => line.match(/refs\/tags\/cli-v([\d.]+)$/)?.[1])
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const latest = tags.at(-1);
if (!latest) throw new Error("no cli-v* tags found upstream");
if (latest === current) {
  console.log(`cline pin already at latest cli-v${latest}`);
  process.exit(0);
}

// Verify the patch still applies to the new tag before touching the pin.
const probe = mkdtempSync(join(tmpdir(), "cline-bump-"));
execFileSync("git", ["clone", "--depth", "1", "--branch", `cli-v${latest}`, "https://github.com/cline/cline.git", probe], { stdio: "inherit" });
execFileSync("git", ["apply", "--check", patchPath], { cwd: probe, stdio: "inherit" });

writeFileSync(buildScript, readFileSync(buildScript, "utf8").replaceAll(`cli-v${current}`, `cli-v${latest}`));
console.log(`bumped Cline pin cli-v${current} -> cli-v${latest}; patch applies cleanly`);
console.log("next: rm -rf .workflow-cline/cline && npm run tui:cline:build && npm test");
