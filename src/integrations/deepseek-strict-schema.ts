import type { ModelProfile } from "./model-profile.js";

/**
 * DeepSeek's server-validated strict-schema base URL (Beta). Selecting this
 * endpoint and applying the translator at request time is the per-vendor proxy
 * composition seam (W070a's `createModelUsageProxy` `transformBody`); see
 * `docs/OPEN_MODEL_ENFORCEMENT.md` §"Composition seam and open dependency".
 */
export const DEEPSEEK_STRICT_BASE_URL = "https://api.deepseek.com/beta";

/**
 * W070b slice 3: DeepSeek server-validated strict tool schemas.
 *
 * DeepSeek's `strict` mode (Beta, `/beta` base URL) validates tool arguments
 * server-side. It accepts only a strict JSON-Schema subset:
 *   - every object property is `required`
 *   - every object has `additionalProperties: false`
 *   - `minLength`/`maxLength`/`minItems`/`maxItems` are unsupported
 *
 * A schema outside that subset cannot be silently loosened — the translator
 * throws `DeepSeekStrictSchemaError` so the offending schema gets fixed at the
 * source. Failures are the signal, not an obstacle to route around.
 */

const STRIPPED_KEYWORDS = new Set(["minLength", "maxLength", "minItems", "maxItems"]);

const REJECTED_KEYWORDS = new Set([
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "prefixItems",
  "contains",
  "$ref",
  "$defs",
  "definitions",
]);

export class DeepSeekStrictSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekStrictSchemaError";
  }
}

export type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectSchema(schema: JsonSchema): boolean {
  return schema.type === "object" || (schema.type === undefined && isRecord(schema.properties));
}

/**
 * Rewrites one JSON schema into DeepSeek's strict subset. Throws when the
 * schema uses a construct that cannot be represented strictly.
 */
export function strictifySchema(schema: JsonSchema): JsonSchema {
  return strictify(schema, "$");
}

function strictify(schema: JsonSchema, path: string): JsonSchema {
  for (const keyword of Object.keys(schema)) {
    if (REJECTED_KEYWORDS.has(keyword)) {
      throw new DeepSeekStrictSchemaError(`strict schema at ${path} uses unsupported keyword '${keyword}'`);
    }
  }

  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (STRIPPED_KEYWORDS.has(key)) continue;
    result[key] = value;
  }

  if (Array.isArray(schema.type)) {
    throw new DeepSeekStrictSchemaError(`strict schema at ${path} uses a type union; split it into distinct tools or an object shape`);
  }

  if (isObjectSchema(schema)) {
    if (schema.properties !== undefined && !isRecord(schema.properties)) {
      throw new DeepSeekStrictSchemaError(`strict schema at ${path} has non-object properties`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
      throw new DeepSeekStrictSchemaError(`strict schema at ${path} has a schema-valued additionalProperties`);
    }
    const strictProperties: Record<string, JsonSchema> = {};
    for (const [name, property] of Object.entries(properties)) {
      if (!isRecord(property)) {
        throw new DeepSeekStrictSchemaError(`strict schema at ${path}.${name} is not an object schema`);
      }
      strictProperties[name] = strictify(property, `${path}.${name}`);
    }
    result.type = "object";
    result.properties = strictProperties;
    // strict mode requires all properties required, in declaration order.
    result.required = Object.keys(strictProperties);
    result.additionalProperties = false;
    return result;
  }

  if (schema.type === "array" || schema.items !== undefined) {
    if (!isRecord(schema.items)) {
      throw new DeepSeekStrictSchemaError(`strict schema at ${path} array has no single object items schema`);
    }
    result.type = "array";
    result.items = strictify(schema.items, `${path}[]`);
    return result;
  }

  return result;
}

export interface ToolDefinition {
  readonly type?: unknown;
  readonly function?: {
    readonly name?: unknown;
    readonly description?: unknown;
    readonly parameters?: unknown;
    readonly strict?: unknown;
  };
}

const EMPTY_OBJECT_SCHEMA: JsonSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

/**
 * Rewrites a tool list for DeepSeek strict mode: strictifies every function's
 * `parameters` and marks the function `strict: true`. Throws
 * `DeepSeekStrictSchemaError` naming the tool when a schema cannot be
 * strictified.
 */
export function strictifyToolDefinitions(tools: readonly unknown[]): ToolDefinition[] {
  return tools.map((tool, index) => {
    if (!isRecord(tool)) {
      throw new DeepSeekStrictSchemaError(`tool at index ${index} is not an object`);
    }
    const fn = tool.function;
    if (!isRecord(fn)) {
      throw new DeepSeekStrictSchemaError(`tool at index ${index} has no function object`);
    }
    const name = typeof fn.name === "string" && fn.name.length > 0 ? fn.name : `tool[${index}]`;
    const parameters = fn.parameters;
    if (parameters !== undefined && !isRecord(parameters)) {
      throw new DeepSeekStrictSchemaError(`tool '${name}' parameters are not an object schema`);
    }
    let strictParameters: JsonSchema;
    try {
      strictParameters = parameters === undefined ? EMPTY_OBJECT_SCHEMA : strictifySchema(parameters);
    } catch (error) {
      if (error instanceof DeepSeekStrictSchemaError) {
        throw new DeepSeekStrictSchemaError(`tool '${name}' cannot be strictified: ${error.message}`);
      }
      throw error;
    }
    return { ...tool, function: { ...fn, parameters: strictParameters, strict: true } };
  });
}

/** Whether the active profile should be served strict schemas through /beta. */
export function shouldUseStrictSchemas(profile: Pick<ModelProfile, "family">): boolean {
  return profile.family === "deepseek";
}
