import { createRequire } from "node:module";

const workspaceRoot = "/var/home/hunter/mcp-toolbox";
const appRoot = `${workspaceRoot}/apps`;
const experimentRoot = process.env.P707_DOGFOOD_ROOT ?? "/tmp/opencode/p707-dogfood";
const require = createRequire(`${workspaceRoot}/apps/project-memory-mcp/package.json`);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const sharedEnv = { ...process.env, XDG_DATA_HOME: `${experimentRoot}/data` };

async function call(app, tool, args, env = sharedEnv) {
  const client = new Client({ name: "p707-producer-replay", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${appRoot}/${app}/dist/server.js`], env, stderr: "pipe" }));
  const result = await client.callTool({ name: tool, arguments: args });
  await client.close();
  if (result.isError) throw new Error(`${tool} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

const reviewedSubject = {
  kind: "fingerprint",
  algorithm: "sha256",
  version: "1",
  scope: "P706 project-context package source/config/tests/docs via git hash-object aggregation",
  value: "71791bda9d2755341071a31ceac71cbbcfd0301139487aa125ed958aa654e4f1",
};

const memory = await call("project-memory-mcp", "record_memory", {
  workspaceRoot,
  kind: "decision",
  paths: ["TODO.md", "apps/project-context-mcp/README.md"],
  content: "P706 project-context discovery is independently approved; P707 must recover Stage 7 state without transcript transfer.",
});
const review = await call("review-accountability-mcp", "record_review", {
  workspaceRoot,
  reviewer: "P706 independent reviewer",
  verdict: "approved",
  blockingSeverities: ["P0", "P1"],
  subject: reviewedSubject,
  findings: [{ severity: "P2", summary: "P707 dogfood must demonstrate that a fresh consumer can recover unresolved follow-up debt before it is resolved.", paths: ["docs/architecture/stage-7-continuity-dogfood.md"] }],
}, { ...sharedEnv, REVIEW_ACCOUNTABILITY_DATA_DIR: `${experimentRoot}/review` });
const verification = await call("verification-accountability-mcp", "record_verification", {
  workspaceRoot,
  request: { kind: "local_test", testIds: ["node:apps/project-context-mcp/test/context.test.ts"], timeoutMs: 120000 },
}, {
  ...sharedEnv,
  VERIFICATION_ACCOUNTABILITY_DATA_DIR: `${experimentRoot}/verification`,
  VERIFICATION_ACCOUNTABILITY_TEST_COMMAND: process.execPath,
  VERIFICATION_ACCOUNTABILITY_TEST_ARGS: JSON.stringify([`${appRoot}/test-intelligence-mcp/dist/server.js`]),
});

console.log(JSON.stringify({ memory, review, verification }, null, 2));
