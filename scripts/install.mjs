import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function step(label, command, args) {
  console.log(`setup: ${label}`);
  try {
    execFileSync(command, args, { cwd: root, stdio: "inherit" });
  } catch (error) {
    console.error(`setup: ${label} failed (${error instanceof Error ? error.message : error})`);
    process.exit(1);
  }
}

step("pnpm availability check", "pnpm", ["--version"]);
step("npm install", "npm", ["install"]);
step("build", "npm", ["run", "build"]);
step("toolbox install", "pnpm", ["--dir", "mcp-toolbox", "install"]);
step("toolbox build", "pnpm", ["--dir", "mcp-toolbox", "run", "build"]);
step("global install", "npm", ["install", "-g", "."]);

console.log("\nInstalled bins: workflow, workflow-tui, workflow-hub, workflow-monitor, workflow-shell");
console.log("Run: workflow --cwd <path>  (browser UI, OpenCode/ACP by default; --no-browser skips opening)");
