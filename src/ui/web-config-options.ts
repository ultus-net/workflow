import type { AcpConfigOptionValue, AcpSessionConfig } from "../adapters/acp-subprocess.js";

/** One agent-advertised configuration option, normalized for the browser. */
export interface WebConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** ACP category: mode | model | model_config | thought_level (or agent-specific). */
  readonly category?: string;
  readonly type: "select" | "boolean";
  readonly currentValue: AcpConfigOptionValue;
  readonly choices?: readonly { readonly value: string; readonly name: string; readonly description?: string }[];
}

function normalizeChoice(value: unknown): { value: string; name: string; description?: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.value !== "string") return undefined;
  return {
    value: entry.value,
    name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.value,
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
  };
}

function normalizeOption(value: unknown): WebConfigOption | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return undefined;
  const type = entry.type === "boolean" ? "boolean" : entry.type === "select" ? "select" : undefined;
  if (type === undefined) return undefined;
  const rawValue = entry.currentValue;
  if (type === "boolean" && typeof rawValue !== "boolean") return undefined;
  if (type === "select" && typeof rawValue !== "string") return undefined;
  const currentValue: AcpConfigOptionValue = rawValue as AcpConfigOptionValue;
  const choices = type === "select"
    ? (Array.isArray(entry.options) ? entry.options : []).flatMap((choice) => {
      const normalized = normalizeChoice(choice);
      return normalized === undefined ? [] : [normalized];
    })
    : undefined;
  if (type === "select" && (choices === undefined || choices.length === 0)) return undefined;
  return {
    id: entry.id,
    name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id,
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    ...(typeof entry.category === "string" ? { category: entry.category } : {}),
    type,
    currentValue,
    ...(choices !== undefined ? { choices } : {}),
  };
}

/**
 * Tolerant projection of the agent's `session/new` config: only well-formed
 * options survive; unknown shapes are dropped (fail-closed, like the rest of
 * the ACP ingress).
 */
export function normalizeConfigOptions(config: AcpSessionConfig | undefined): WebConfigOption[] {
  const raw = config?.configOptions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const normalized = normalizeOption(entry);
    return normalized === undefined ? [] : [normalized];
  });
}
