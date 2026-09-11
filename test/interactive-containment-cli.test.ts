import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("interactive containment CLI authorizes and contains every command until exit", async () => {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli/contained-shell.ts"],
    { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let sentCommands = false;
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    if (sentCommands) return;
    const workspace = stdout.match(/Writable workspace: (\/tmp\/workflow-interactive-[^\n]+)/)?.[1];
    if (workspace === undefined) return;
    sentCommands = true;
    child.stdin.end([
      `printf persisted-command > ${workspace}/session.txt`,
      "false",
      `cat ${workspace}/session.txt`,
      "exit",
      "",
    ].join("\n"));
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /Policy: ALLOW/);
  assert.match(stdout, /Containment: ENFORCED/);
  assert.match(stdout, /persisted-command/);
  assert.equal(stdout.match(/Policy: ALLOW/g)?.length, 3);
  assert.equal(stdout.match(/Containment: ENFORCED/g)?.length, 3);
  assert.equal(stdout.match(/Task: VERIFIED/g)?.length, 2);
  assert.equal(stdout.match(/Task: FAILED/g)?.length, 1);
});
