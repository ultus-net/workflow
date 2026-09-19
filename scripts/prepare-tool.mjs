import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function step(name, command, args) {
  try {
    execFileSync(command, args, { cwd: root, stdio: "inherit" });
    console.log(`prepare: ${name} ok`);
  } catch (error) {
    console.warn(`prepare: ${name} skipped (${error instanceof Error ? error.message : error})`);
  }
}

step("toolbox", "pnpm", ["--dir", resolve(root, "mcp-toolbox"), "run", "build"]);
