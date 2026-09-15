export interface FailureDescription {
  readonly summary: string;
  readonly detail: string | undefined;
}

/**
 * Translates raw session failure reasons (often JSON-RPC error payloads) into
 * a plain-language cause plus one next step. The raw text stays available as
 * secondary detail; unknown shapes degrade to their first line.
 */
export function describeFailure(reason: string): FailureDescription {
  const parsed = parseEmbeddedJson(reason);
  const message = parsed ?? reason;
  const lower = message.toLowerCase();

  if (lower.includes("cannot connect to api") || lower.includes("connectionrefused")) {
    return {
      summary: "The agent couldn't reach the model API (connection refused). Check that the Workflow service is healthy, then retry.",
      detail: detailOf(reason, parsed),
    };
  }
  if (lower.includes("cancelled") || lower.includes("canceled")) {
    return { summary: "The turn was cancelled.", detail: detailOf(reason, parsed) };
  }
  if (lower.includes("denied") || lower.includes("not authorized") || lower.includes("unauthorized")) {
    return {
      summary: "Workflow denied this action. Review the authorization panel or adjust the request.",
      detail: detailOf(reason, parsed),
    };
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      summary: "The model API timed out. Retry, or simplify the prompt.",
      detail: detailOf(reason, parsed),
    };
  }
  const firstLine = message.split("\n").find((line) => line.trim().length > 0) ?? "The turn failed.";
  return {
    summary: firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine,
    detail: detailOf(reason, parsed),
  };
}

/** Extracts the message from an embedded JSON-RPC error payload, if present. */
function parseEmbeddedJson(reason: string): string | undefined {
  const start = reason.indexOf("{");
  if (start === -1) return undefined;
  try {
    const parsed = JSON.parse(reason.slice(start)) as { message?: unknown; data?: { message?: unknown } };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.data?.message === "string") return parsed.data.message;
  } catch {
    // Not a JSON payload; fall through.
  }
  return undefined;
}

/** Keeps the raw reason as detail only when it adds information beyond the summary source. */
function detailOf(reason: string, parsed: string | undefined): string | undefined {
  if (parsed !== undefined && parsed !== reason) return reason;
  return undefined;
}
