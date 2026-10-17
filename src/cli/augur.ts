#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { loadConfigFile, resolveConfig, resolveWorkspace, ensureWorkspace } from "../assistant/config.js";
import { LangSchema } from "../assistant/model/source.js";
import { AUDIENCES, isAudience } from "../assistant/style/audience.js";
import { listStyles, loadStyle } from "../assistant/style/pack.js";
import { formatFindings, lint } from "../assistant/lint.js";
import { run, type RunRequest } from "../assistant/run.js";
import { OpenRouterProvider, resolveProviderTransport } from "../assistant/provider/openrouter.js";
import { runResearchEntry } from "../assistant/research/entry.js";
import { researchBudget } from "../assistant/research/conductor.js";
import type { ResearchComplexity } from "../assistant/research/types.js";
import { startDiscordConnector } from "../assistant/discord/connector.js";
import type { DiscordAllowlist } from "../assistant/discord/allowlist.js";

const USAGE = `augur - turn sources into styled notes

Usage:
  augur note <source> [options]     source: URL, file path, or - for stdin
  augur research <question>         deep research: plan, dispatch workers, synthesize
  augur lint <file>                 check a note against its style pack
  augur styles list                 list available style packs
  augur discord                     run the Discord connector (outbound-only)

Options:
  --style <id>       style pack id (default: notes)
  --audience <a>     junior | mid | senior (default: mid)
  --lang <tag>       en | zh-Hans (default: en)
  --out <file>       write output to a file instead of stdout
  --workspace <dir>  working directory for inputs/outputs (default: ~/.local/share/augur/workspace)
  --no-research      disable web-search grounding and references
  --no-verify        skip the post-generation fact/currency verification
  --models <list>    comma-separated OpenRouter model IDs, priority order
  --variant <s>      routing suffix applied to all models (e.g. :nitro)
  --no-lint          skip the post-generation lint
  --complexity <c>   research only: simple | comparison | complex (default: comparison)
  --max-cost-usd <n> research only: override the complexity-derived dollar ceiling
  --max-subagents <n> research only: override the complexity-derived subagent ceiling
  --run-id <id>      research only: durable run id (default: a hash of the question)

Env:
  OPENROUTER_API_KEY   required for generation
  AUGUR_MODELS         default model list
  AUGUR_CONFIG         alternate config path
  DISCORD_BOT_TOKEN    required for \`augur discord\`
  AUGUR_GATEWAY_URL    required for \`augur discord\` (assistant gateway base URL)
  AUGUR_GATEWAY_BASIC_AUTH required: front-door client credential (user:pass or base64)
  AUGUR_DISCORD_ALLOW  comma-separated allowed guild/channel/user ids (empty = open)
  AUGUR_DISCORD_DENY   comma-separated denied guild/channel/user ids (deny wins)

Note: \`augur discord\` requires the Message Content privileged intent enabled
in the Discord application settings.

Examples:
  augur note https://www.youtube.com/watch?v=zjkBMFhNj_g --audience junior
  cat transcript.txt | augur note - --style essay --audience senior
  augur note slides.pdf --lang zh-Hans --style hybrid
  augur research "state of open-weight coding models" --complexity comparison
  augur research "compare X and Y" --max-subagents 4 --out answer.md
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdNote(source: string, flags: Record<string, unknown>): Promise<number> {
  const audience = isAudience(String(flags.audience ?? "mid"))
    ? (flags.audience as RunRequest["audience"])
    : "mid";
  const req: RunRequest = {
    source,
    audience,
    research: flags.research !== false,
    verify: flags.verify !== false,
  };
  if (typeof flags.style === "string") req.style = flags.style;
  if (flags.lang === "en" || flags.lang === "zh-Hans") req.lang = flags.lang;

  const cfg = resolveConfig(loadConfigFile(), flags);
  const wsFlag = typeof flags.workspace === "string" ? flags.workspace : undefined;
  const ws = ensureWorkspace(resolveWorkspace(cfg, wsFlag));

  let outPath: string | undefined;
  if (typeof flags.out === "string") {
    outPath = isAbsolute(flags.out) ? flags.out : join(ws, flags.out);
    mkdirSync(dirname(outPath), { recursive: true });
    req.out = outPath;
  }

  const result = await run(req, readStdin, {
    onStatus: (m) => process.stderr.write(`${m}\n`),
  });

  if (outPath !== undefined) {
    writeFileSync(outPath, result.markdown, "utf8");
    process.stderr.write(`wrote ${outPath}\n`);
    // W212 (hub Note view, decision-brief Option A): a markdown note gets its
    // admission sidecar `<slug>.json` beside `<slug>.md`, so the hub's Note
    // view has real metadata to render. Only facts the run actually produced
    // ride the sidecar (unknown fields stay absent, never fabricated); the
    // stdout path and every flag's semantics are unchanged.
    if (outPath.endsWith(".md")) {
      const sidecar = {
        source,
        producedAt: new Date().toISOString(),
        blocked: result.blocked,
        findings: result.lint.findings.length,
      };
      writeFileSync(outPath.slice(0, -".md".length) + ".json", JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    }
  } else {
    process.stdout.write(result.markdown);
  }

  if (flags["no-lint"] !== true) {
    process.stderr.write(`${formatFindings(result.lint)}\n`);
  }
  if (result.blocked) {
    process.stderr.write("note held: verification found a claim that must not ship unqualified (see Verification notes).\n");
  }
  return 0;
}

/** Parse a comma-separated env id list into a trimmed, non-empty array. */
function parseIdList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(",").map((id) => id.trim()).filter((id) => id !== "");
}

/** Thin entry: parse env, wire the connector, block until SIGINT/SIGTERM. */
async function cmdDiscord(): Promise<number> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("augur discord requires DISCORD_BOT_TOKEN");
  const gatewayUrl = process.env.AUGUR_GATEWAY_URL;
  if (!gatewayUrl) throw new Error("augur discord requires AUGUR_GATEWAY_URL");
  // The front door enforces its client Basic credential before the assistant
  // lane, so the connector must present it. Accept `user:pass` directly or a
  // pre-encoded value.
  const basicCred = process.env.AUGUR_GATEWAY_BASIC_AUTH;
  if (!basicCred) throw new Error("augur discord requires AUGUR_GATEWAY_BASIC_AUTH (the front-door client credential, user:pass or base64)");
  const basicAuth = basicCred.includes(":") ? Buffer.from(basicCred).toString("base64") : basicCred;

  const allowlist: DiscordAllowlist = {
    allow: parseIdList(process.env.AUGUR_DISCORD_ALLOW),
    deny: parseIdList(process.env.AUGUR_DISCORD_DENY),
  };
  const model = process.env.AUGUR_MODELS?.split(",")[0]?.trim() || undefined;

  const connector = await startDiscordConnector({
    token,
    gatewayUrl,
    basicAuth,
    allowlist,
    ...(model === undefined ? {} : { model }),
  });
  process.stderr.write("augur discord: connected\n");

  await new Promise<void>((resolve) => {
    const shutdown = (): void => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await connector.stop();
  return 0;
}

async function cmdLint(file: string, flags: Record<string, unknown>): Promise<number> {
  const cfg = resolveConfig(loadConfigFile(), { style: flags.style });
  const pack = loadStyle(cfg.style);
  const audience = isAudience(String(flags.audience ?? "mid")) ? (flags.audience as "junior" | "mid" | "senior") : "mid";
  const md = readFileSync(file, "utf8");
  const res = lint(md, pack, audience);
  process.stdout.write(`${formatFindings(res)}\n`);
  return res.ok ? 0 : 1;
}

const COMPLEXITIES: readonly string[] = ["simple", "comparison", "complex"];

function requireComplexity(value: unknown): ResearchComplexity {
  const raw = value === undefined ? "comparison" : String(value);
  if (!COMPLEXITIES.includes(raw)) {
    throw new Error(`unknown complexity '${raw}': expected one of ${COMPLEXITIES.join(", ")}`);
  }
  return raw as ResearchComplexity;
}

/** Parse an optional numeric flag; a non-numeric value fails loudly. */
function optionalNumber(flags: Record<string, unknown>, key: string): number | undefined {
  const raw = flags[key];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number, got '${String(raw)}'`);
  return parsed;
}

async function cmdResearch(question: string, flags: Record<string, unknown>): Promise<number> {
  const cfg = resolveConfig(loadConfigFile(), flags);
  const wsFlag = typeof flags.workspace === "string" ? flags.workspace : undefined;
  const ws = ensureWorkspace(resolveWorkspace(cfg, wsFlag));
  const complexity = requireComplexity(flags.complexity);
  // A deterministic run id keeps re-running the SAME question on the SAME
  // durable run: the second invocation resumes from the checkpoint instead of
  // re-spending the frontier tier.
  const runId = typeof flags["run-id"] === "string" && flags["run-id"].length > 0
    ? flags["run-id"]
    : createHash("sha256").update(question).digest("hex").slice(0, 16);
  const root = join(ws, "research", runId);

  const transport = resolveProviderTransport();
  const provider = new OpenRouterProvider({ ...transport, config: cfg.provider });

  const maxCostUsd = optionalNumber(flags, "max-cost-usd");
  const maxSubagents = optionalNumber(flags, "max-subagents");

  const result = await runResearchEntry({
    question,
    complexity,
    lang: cfg.lang,
    runId,
    root,
    provider,
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    ...(maxSubagents === undefined ? {} : { maxSubagents }),
  });

  if (typeof flags.out === "string") {
    const outPath = isAbsolute(flags.out) ? flags.out : join(ws, flags.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.outcome.answer, "utf8");
    process.stderr.write(`wrote ${outPath}\n`);
  } else {
    process.stdout.write(result.outcome.answer);
  }

  // Honest one-line status on stderr: the numbers are the run's REAL usage
  // against its budget, and exhaustion is stated plainly rather than hidden.
  const budget = researchBudget(complexity);
  const maxSubagentsUsed = maxSubagents ?? budget.maxSubagents;
  const usage = result.outcome.usage;
  process.stderr.write(
    `research ${runId} [${complexity}]: ${usage.subagents}/${maxSubagentsUsed} subagents, ` +
      `${usage.toolCalls} tool calls, $${usage.costUsd.toFixed(4)}` +
      `${result.outcome.budgetExhausted ? " (budget exhausted: plan not completed)" : ""}\n` +
      `answer: ${result.answerPath} | artifacts: ${result.artifactRoot}\n`,
  );
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      style: { type: "string" },
      audience: { type: "string" },
      lang: { type: "string" },
      out: { type: "string" },
      workspace: { type: "string" },
      models: { type: "string" },
      variant: { type: "string" },
      complexity: { type: "string" },
      "max-cost-usd": { type: "string" },
      "max-subagents": { type: "string" },
      "run-id": { type: "string" },
      research: { type: "boolean", default: true },
      "no-research": { type: "boolean" },
      verify: { type: "boolean", default: true },
      "no-verify": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      "no-lint": { type: "boolean" },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return positionals.length === 0 && !values.help ? 1 : 0;
  }

  if (values.models) process.env.AUGUR_MODELS = values.models;
  if (values.variant) process.env.AUGUR_VARIANT = values.variant;
  if (values.lang) LangSchema.parse(values.lang);
  if (values["no-research"]) values.research = false;
  if (values["no-verify"]) values.verify = false;

  const [cmd, arg] = positionals;
  const flags = values as Record<string, unknown>;

  switch (cmd) {
    case "note":
      if (!arg) throw new Error("note requires a source (URL, path, or -)");
      return cmdNote(arg, flags);
    case "research":
      if (!arg) throw new Error("research requires a question");
      return cmdResearch(arg, flags);
    case "lint":
      if (!arg) throw new Error("lint requires a file path");
      return cmdLint(arg, flags);
    case "styles": {
      if (arg === "list") {
        for (const s of listStyles()) process.stdout.write(`${s}\n`);
        return 0;
      }
      throw new Error("unknown styles subcommand");
    }
    case "audiences": {
      for (const a of Object.values(AUDIENCES)) process.stdout.write(`${a.id}\t${a.blurb}\n`);
      return 0;
    }
    case "discord":
      return cmdDiscord();
    default:
      process.stderr.write(USAGE);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
