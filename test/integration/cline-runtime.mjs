import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL, URL } from "node:url";

const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const coreUrl = pathToFileURL(join(npmRoot, "cline", "node_modules", "@cline", "core", "dist", "index.js"));
let core;
try {
  core = await import(coreUrl.href);
} catch (error) {
  throw new Error("test:cline-runtime requires the Cline CLI with @cline/core installed globally", { cause: error });
}

const fixture = new URL("./cline-plugin-fixture.mjs", import.meta.url);
const plugin = await core.loadAgentPluginFromPath(fixture.pathname);
assert.equal(plugin.name, "workflow");
assert.deepEqual(plugin.manifest.capabilities, ["hooks"]);
assert.deepEqual(await plugin.hooks.beforeTool({
  toolCall: { toolName: "write_file" },
  input: { path: "src/protected.ts" },
}), {
  stop: true,
  reason: "task A is READY, not IN_PROGRESS",
});
