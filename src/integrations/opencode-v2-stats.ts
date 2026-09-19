export interface OpenCodeV2ToolTotals {
  readonly calls: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly unfinished: number;
}

export interface OpenCodeV2SessionStats {
  readonly sessions: number;
  readonly subagents: number;
  readonly prompts: number;
  readonly steps: number;
  readonly cost: number;
  readonly tools: OpenCodeV2ToolTotals;
}

/** Normalizes the observed v2 experimental.session.stats envelope. */
export function parseOpenCodeV2SessionStats(value: unknown): OpenCodeV2SessionStats {
  if (typeof value !== "object" || value === null) throw new TypeError("v2 stats response must be an object");
  const data = (value as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) throw new TypeError("v2 stats response lacks data");
  const record = data as Record<string, unknown>;
  const tools = record.tools;
  if (typeof tools !== "object" || tools === null) throw new TypeError("v2 stats response lacks tools");
  const totals = (tools as Record<string, unknown>).totals;
  if (typeof totals !== "object" || totals === null) throw new TypeError("v2 stats response lacks tool totals");
  const number = (key: string): number => {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`v2 stats field ${key} is invalid`);
    return value;
  };
  const toolNumber = (key: string): number => {
    const value = (totals as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`v2 stats tool field ${key} is invalid`);
    return value;
  };
  return {
    sessions: number("sessions"),
    subagents: number("subagents"),
    prompts: number("prompts"),
    steps: number("steps"),
    cost: number("cost"),
    tools: { calls: toolNumber("calls"), succeeded: toolNumber("succeeded"), failed: toolNumber("failed"), unfinished: toolNumber("unfinished") },
  };
}