import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { LangSchema } from "./model/source.js";

/**
 * Run configuration. Precedence: CLI flag > env var > config file > default.
 * API keys come from env only, never from a file we write.
 */

export const ConfigSchema = z.object({
  provider: z.object({
    /** OpenRouter model IDs in priority order. Failover on error/refusal. */
    models: z.array(z.string()).default([]),
    /** Appended to every model ID. Example: ":nitro" or ":floor". */
    variant: z.string().default(""),
    /** Optional provider slugs to pin, in order. */
    order: z.array(z.string()).optional(),
    /** Restrict to only these provider slugs. */
    only: z.array(z.string()).optional(),
    /** Skip these provider slugs. */
    ignore: z.array(z.string()).optional(),
    allowFallbacks: z.boolean().default(true),
  }).default({}),
  lang: LangSchema.default("en"),
  style: z.string().default("notes"),
  out: z.string().optional(),
  workspace: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  const xdgHome = process.env.XDG_CONFIG_HOME;
  return process.env.AUGUR_CONFIG ??
    (xdgHome && xdgHome.length > 0 ? join(xdgHome, "augur", "config.yaml") : join(homedir(), ".config", "augur", "config.yaml"));
}

export function loadConfigFile(): Record<string, unknown> {
  const p = configPath();
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, "utf8");
  const parsed = parseYaml(raw);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/** Deep-ish merge: file first, then env, then flags. Only two levels deep. */
export function resolveConfig(file: Record<string, unknown>, flags: Record<string, unknown>): Config {
  const merged: Record<string, unknown> = { ...file };
  const provider = { ...((file.provider as Record<string, unknown>) ?? {}) };

  if (process.env.AUGUR_MODELS) {
    provider.models = process.env.AUGUR_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (process.env.AUGUR_VARIANT) provider.variant = process.env.AUGUR_VARIANT;
  if (process.env.AUGUR_LANG) merged.lang = process.env.AUGUR_LANG;

  merged.provider = provider;
  for (const [k, v] of Object.entries(flags)) {
    if (v !== undefined) merged[k] = v;
  }
  return ConfigSchema.parse(merged);
}

export function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Export it, or add it to your shell profile.",
    );
  }
  return key;
}

export function resolveWorkspace(cfg: Config, flag?: string): string {
  const xdgDataHome = process.env.XDG_DATA_HOME;
  const defaultWorkspace = xdgDataHome && xdgDataHome.length > 0
    ? join(xdgDataHome, "augur", "workspace")
    : join(homedir(), ".local", "share", "augur", "workspace");

  if (flag) return flag;
  if (process.env.AUGUR_WORKSPACE) return process.env.AUGUR_WORKSPACE;
  if (cfg.workspace) return cfg.workspace;

  return defaultWorkspace;
}

export function ensureWorkspace(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
