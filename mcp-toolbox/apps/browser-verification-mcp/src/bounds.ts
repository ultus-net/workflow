/**
 * Bounded surface definitions for browser-verification-mcp.
 *
 * Everything the model can ask for is enumerated here and checked before a
 * CDP command is issued: URLs, CSS selectors, action kinds, key names, and
 * assertion kinds. There is deliberately no `evaluate`/arbitrary-script
 * action, no shell, and no download path — the only browser control surface
 * is this allowlist.
 */

export type Profile = "verification" | "debug";

export const LIMITS = {
  maxUrlChars: 2_048,
  maxSelectorChars: 300,
  maxTextInputChars: 2_000,
  maxPatternChars: 500,
  maxCommandTimeoutMs: 30_000,
  defaultCommandTimeoutMs: 15_000,
  maxNavigationTimeoutMs: 60_000,
  defaultNavigationTimeoutMs: 25_000,
  defaultFlowTimeoutMs: 60_000,
  maxScreenshotBytes: 1_000_000,
  maxScreenshotsPerSession: 25,
  maxAxNodes: 400,
  maxAxNameChars: 400,
  maxConsoleMessages: 200,
  maxNetworkRequests: 200,
  maxTraceEvents: 200,
  maxEvidenceRecords: 200,
  maxDebugDurationMs: 10_000,
  minDebugDurationMs: 100,
  maxEvidenceListLimit: 50,
} as const;

export interface ActionTarget {
  readonly selector?: string;
}

export type BrowserAction =
  | { readonly kind: "click"; readonly selector: string }
  | { readonly kind: "type"; readonly selector: string; readonly text: string }
  | { readonly kind: "clear"; readonly selector: string }
  | { readonly kind: "press"; readonly key: string; readonly selector?: string };

export type BrowserAssertion =
  | { readonly kind: "text_visible"; readonly text: string }
  | { readonly kind: "text_absent"; readonly text: string }
  | { readonly kind: "element_exists"; readonly selector: string }
  | { readonly kind: "element_absent"; readonly selector: string }
  | { readonly kind: "attribute_equals"; readonly selector: string; readonly name: string; readonly value: string }
  | { readonly kind: "url_contains"; readonly text: string }
  | { readonly kind: "title_contains"; readonly text: string };

const KEY_MAP: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { code: "Space", keyCode: 32, text: " " },
};

export const ALLOWED_KEYS: readonly string[] = Object.freeze(Object.keys(KEY_MAP));

export function normalizeKey(value: string): { code: string; keyCode: number; text?: string; key: string } {
  const entry = KEY_MAP[value];
  if (!entry) throw new Error(`Key "${value}" is not in the browser action allowlist.`);
  return { ...entry, key: value };
}

const CONTROL_CHARS = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function bounded(value: string, name: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty.`);
  if (Buffer.byteLength(trimmed) > max) throw new Error(`${name} exceeds its ${max}-byte limit.`);
  if (CONTROL_CHARS.test(trimmed)) throw new Error(`${name} contains control characters.`);
  return trimmed;
}

export function validateSelector(value: string): string {
  const selector = bounded(value, "Selector", LIMITS.maxSelectorChars);
  if (selector.includes("\u0000") || selector.includes("\n") || selector.includes("\r")) throw new Error("Selector is invalid.");
  return selector;
}

export function validateText(value: string, name = "Text"): string {
  if (CONTROL_CHARS.test(value)) throw new Error(`${name} contains control characters.`);
  if (Buffer.byteLength(value) > LIMITS.maxTextInputChars) throw new Error(`${name} exceeds its ${LIMITS.maxTextInputChars}-byte limit.`);
  return value;
}

export function validatePattern(value: string): string {
  return bounded(value, "Pattern", LIMITS.maxPatternChars);
}

export interface ValidatedUrl {
  readonly url: string;
  readonly origin: string;
}

export function validateHttpUrl(value: string, allowedOrigins: readonly string[] = []): ValidatedUrl {
  const raw = bounded(value, "URL", LIMITS.maxUrlChars);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("URL must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("URL scheme must be http or https.");
  if (allowedOrigins.length > 0 && !allowedOrigins.includes(parsed.origin)) {
    throw new Error(`URL origin ${parsed.origin} is not in the configured allowlist.`);
  }
  return { url: parsed.toString(), origin: parsed.origin };
}

export function validateAction(action: BrowserAction): BrowserAction {
  switch (action.kind) {
    case "click":
      return { kind: "click", selector: validateSelector(action.selector) };
    case "clear":
      return { kind: "clear", selector: validateSelector(action.selector) };
    case "type":
      return { kind: "type", selector: validateSelector(action.selector), text: validateText(action.text) };
    case "press": {
      normalizeKey(action.key);
      return action.selector === undefined
        ? { kind: "press", key: action.key }
        : { kind: "press", key: action.key, selector: validateSelector(action.selector) };
    }
    default: {
      const never: never = action;
      throw new Error(`Unsupported action: ${JSON.stringify(never)}`);
    }
  }
}

export function validateAssertion(assertion: BrowserAssertion): BrowserAssertion {
  switch (assertion.kind) {
    case "text_visible":
    case "text_absent":
      return { kind: assertion.kind, text: bounded(assertion.text, "Assertion text", LIMITS.maxPatternChars) };
    case "element_exists":
    case "element_absent":
      return { kind: assertion.kind, selector: validateSelector(assertion.selector) };
    case "attribute_equals":
      return {
        kind: "attribute_equals",
        selector: validateSelector(assertion.selector),
        name: bounded(assertion.name, "Attribute name", 200),
        value: bounded(assertion.value, "Attribute value", LIMITS.maxPatternChars),
      };
    case "url_contains":
    case "title_contains":
      return { kind: assertion.kind, text: bounded(assertion.text, "Assertion text", LIMITS.maxPatternChars) };
    default: {
      const never: never = assertion;
      throw new Error(`Unsupported assertion: ${JSON.stringify(never)}`);
    }
  }
}

export function boundedDuration(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}