import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const workspaceRoot = "/var/home/hunter/mcp-toolbox";
const appRoot = `${workspaceRoot}/apps`;
const packageRoot = `${appRoot}/project-context-mcp`;
const experimentRoot = process.env.P707_DOGFOOD_ROOT ?? "/tmp/opencode/p707-dogfood";
const require = createRequire(`${workspaceRoot}/apps/project-memory-mcp/package.json`);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const sharedEnv = { ...process.env, XDG_DATA_HOME: `${experimentRoot}/data` };
const fingerprintFiles = [
  "package.json",
  "tsconfig.json",
  "src/project-context.ts",
  "src/server.ts",
  "test/context.test.ts",
  "test/mcp.test.ts",
  "README.md",
];

function fingerprint(paths, cwd) {
  const objectIds = execFileSync("git", ["hash-object", ...paths], { cwd, encoding: "utf8" });
  return createHash("sha256").update(objectIds).digest("hex");
}

async function call(app, tool, args, env = sharedEnv) {
  const client = new Client({ name: "p707-pi-consumer", version: "1" });
  const started = performance.now();
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [`${appRoot}/${app}/dist/server.js`],
    env,
    stderr: "pipe",
  }));
  const connected = performance.now();
  const result = await client.callTool({ name: tool, arguments: args });
  const finished = performance.now();
  await client.close();
  if (result.isError) throw new Error(`${tool} failed`);
  return {
    content: result.structuredContent,
    connectMs: connected - started,
    callMs: finished - connected,
    bytes: Buffer.byteLength(JSON.stringify(result.structuredContent)),
  };
}

const memory = await call("project-memory-mcp", "search_memory", { workspaceRoot, query: "Stage 7 P706 P707 continuity handoff", limit: 8 });
const reviewEnv = { ...sharedEnv, REVIEW_ACCOUNTABILITY_DATA_DIR: `${experimentRoot}/review` };
const reviews = await call("review-accountability-mcp", "list_reviews", { workspaceRoot, limit: 20, followUpLimit: 20 }, reviewEnv);
const verification = await call("verification-accountability-mcp", "list_verifications", { workspaceRoot, limit: 20 }, { ...sharedEnv, VERIFICATION_ACCOUNTABILITY_DATA_DIR: `${experimentRoot}/verification` });
const context = await call("project-context-mcp", "discover_project_context", { workspaceRoot, limit: 3 });

const subject = reviews.content.reviews[0]?.subject;
if (!subject || subject.kind !== "fingerprint") throw new Error("No fingerprint review recovered.");
const exact = await call("review-accountability-mcp", "list_reviews", { workspaceRoot, currentSubject: subject, limit: 20, followUpLimit: 20 }, reviewEnv);
const currentFingerprint = fingerprint(fingerprintFiles, packageRoot);
const reviewedFingerprint = fingerprint([
  ...fingerprintFiles.slice(0, -1).map((path) => `${packageRoot}/${path}`),
  `${workspaceRoot}/docs/architecture/fixtures/p706-reviewed-README.md`,
], workspaceRoot);
const establishedCurrent = await call("review-accountability-mcp", "list_reviews", { workspaceRoot, currentSubject: { ...subject, value: currentFingerprint }, limit: 20, followUpLimit: 20 }, reviewEnv);

const calls = [memory, reviews, verification, context, exact, establishedCurrent];
console.log(JSON.stringify({
  recovered: {
    memories: memory.content.records.length,
    reviews: reviews.content.reviews.length,
    openFollowUps: reviews.content.openFollowUps.length,
    verifications: verification.content.observations.length,
    verificationResult: verification.content.observations[0]?.result,
    verificationFreshness: verification.content.observations[0]?.freshness,
    planningSources: context.content.candidates.map(({ path, precedence, trust, snippetTruncated }) => ({ path, precedence, trust, snippetTruncated })),
    exactReviewFreshness: exact.content.reviews[0]?.freshness,
    establishedCurrentReviewFreshness: establishedCurrent.content.reviews[0]?.freshness,
    reviewedFingerprint,
    currentFingerprint,
    reviewedFingerprintMatchesAttestation: reviewedFingerprint === subject.value,
  },
  metrics: {
    toolCalls: calls.length,
    bytes: calls.reduce((sum, item) => sum + item.bytes, 0),
    connectMs: calls.map(({ connectMs }) => connectMs),
    callMs: calls.map(({ callMs }) => callMs),
  },
}, null, 2));
