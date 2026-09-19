/**
 * W070a: credential custody for the open-source vendor keys. Mirrors the
 * existing OpenRouter/Cline posture: an env override first, then a 0600 key
 * file under `~/.config/workflow/`. The keys live ONLY proxy-side — agents
 * receive the metering placeholder and a loopback base URL, never the real
 * vendor key.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ModelFamily } from "./model-profile.js";

export const OPEN_MODEL_KEY_ENV: Readonly<Record<ModelFamily, readonly string[]>> = {
  deepseek: ["DEEPSEEK_API_KEY", "WORKFLOW_DEEPSEEK_API_KEY"],
  glm: ["ZAI_API_KEY", "GLM_API_KEY", "WORKFLOW_GLM_API_KEY"],
  kimi: ["MOONSHOT_API_KEY", "KIMI_API_KEY", "WORKFLOW_KIMI_API_KEY"],
};

export const OPEN_MODEL_KEY_FILES: Readonly<Record<ModelFamily, readonly string[]>> = {
  deepseek: ["deepseek-api-key"],
  glm: ["zai-api-key", "glm-api-key"],
  kimi: ["kimi-api-key", "moonshot-api-key"],
};

export interface OpenModelKeys {
  readonly keys: Readonly<Partial<Record<ModelFamily, string>>>;
  readonly missing: readonly ModelFamily[];
}

export interface LoadOpenModelKeysOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable for tests. */
  readonly readFile?: (path: string) => string;
  readonly home?: string;
}

/**
 * Resolves each family's key from env (first non-empty override) or its
 * key file. Whitespace-only values are treated as unset, matching the
 * deliberate tightening in `loadUpstreamApiKey`.
 */
export function loadOpenModelKeys(options: LoadOpenModelKeysOptions = {}): OpenModelKeys {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
  const keys: Partial<Record<ModelFamily, string>> = {};
  const missing: ModelFamily[] = [];
  for (const family of Object.keys(OPEN_MODEL_KEY_ENV) as ModelFamily[]) {
    const fromEnv = firstNonEmpty(OPEN_MODEL_KEY_ENV[family].map((name) => env[name]));
    const key = fromEnv ?? firstNonEmpty(OPEN_MODEL_KEY_FILES[family].map((name) => readKeyFile(resolve(home, ".config", "workflow", name), readFile)));
    if (key === undefined) missing.push(family);
    else keys[family] = key;
  }
  return { keys, missing };
}

function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== "") return trimmed;
  }
  return undefined;
}

function readKeyFile(path: string, readFile: (path: string) => string): string | undefined {
  try {
    return readFile(path).trim();
  } catch {
    return undefined;
  }
}
