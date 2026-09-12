import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = resolve(root, ".workflow-cline", "cline");
const patch = resolve(root, "patches", "cline-cli-v3.0.61-workflow.patch");
const sdkBuild = resolve(checkout, "sdk", "packages", "core", "dist", "index.js");

mkdirSync(dirname(checkout), { recursive: true });
let needsBuild = false;
if (!existsSync(resolve(checkout, ".git"))) {
  run("git", ["clone", "--depth", "1", "--branch", "cli-v3.0.61", "https://github.com/cline/cline.git", checkout], root);
  needsBuild = true;
}

const revision = output("git", ["describe", "--tags", "--exact-match", "HEAD"], checkout);
if (revision !== "cli-v3.0.61") throw new Error(`expected Cline cli-v3.0.61, found ${revision}`);
const alreadyPatched = spawnSync("git", ["apply", "--reverse", "--check", patch], { cwd: checkout, stdio: "ignore" }).status === 0;
if (!alreadyPatched) {
  if (output("git", ["status", "--porcelain"], checkout) !== "") throw new Error("Cline checkout has unexpected local changes");
  run("git", ["apply", "--check", patch], checkout);
  run("git", ["apply", patch], checkout);
  needsBuild = true;
}
if (needsBuild || !existsSync(sdkBuild)) {
  run("npx", ["--yes", "bun@1.3.13", "install", "--frozen-lockfile"], checkout);
  run("npx", ["--yes", "bun@1.3.13", "run", "build:sdk"], checkout);
}

console.log(`Workflow Cline TUI is ready at ${checkout}`);

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function output(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}
