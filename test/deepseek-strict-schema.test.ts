import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DeepSeekStrictSchemaError,
  shouldUseStrictSchemas,
  strictifySchema,
  strictifyToolDefinitions,
} from "../src/integrations/deepseek-strict-schema.js";
import { modelProfile } from "../src/integrations/model-profile.js";

test("strictifySchema: all properties required, additionalProperties false, keywords stripped", () => {
  const strict = strictifySchema({
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 200 },
      options: {
        type: "object",
        properties: {
          recursive: { type: "boolean" },
          tags: { type: "array", items: { type: "string" }, minItems: 1 },
        },
      },
    },
    additionalProperties: true,
  });

  assert.deepEqual(strict, {
    type: "object",
    properties: {
      path: { type: "string" },
      options: {
        type: "object",
        properties: {
          recursive: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["recursive", "tags"],
        additionalProperties: false,
      },
    },
    required: ["path", "options"],
    additionalProperties: false,
  });
  assert.equal("minLength" in (strict.properties as Record<string, Record<string, unknown>>).path!, false);
});

test("strictifySchema: schemas without explicit object type are treated as objects", () => {
  const strict = strictifySchema({ properties: { file: { type: "string" } } });
  assert.equal(strict.type, "object");
  assert.deepEqual(strict.required, ["file"]);
  assert.equal(strict.additionalProperties, false);
});

test("strictifySchema fails loudly on unsupported composition keywords", () => {
  assert.throws(
    () => strictifySchema({ type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } } }),
    DeepSeekStrictSchemaError,
  );
  assert.throws(
    () => strictifySchema({ type: "object", properties: { ref: { $ref: "#/$defs/Thing" } } }),
    DeepSeekStrictSchemaError,
  );
});

test("strictifySchema fails loudly on schema-valued additionalProperties and type unions", () => {
  assert.throws(
    () => strictifySchema({ type: "object", additionalProperties: { type: "string" } }),
    DeepSeekStrictSchemaError,
  );
  assert.throws(() => strictifySchema({ type: ["string", "number"] }), DeepSeekStrictSchemaError);
});

test("strictifyToolDefinitions marks strict and names the offending tool on failure", () => {
  const tools = strictifyToolDefinitions([
    { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    { type: "function", function: { name: "no_args" } },
  ]);
  const first = tools[0]?.function;
  assert.equal(first?.strict, true);
  assert.equal((first?.parameters as Record<string, unknown>).additionalProperties, false);
  const second = tools[1]?.function;
  assert.equal(second?.strict, true);
  assert.deepEqual(second?.parameters, { type: "object", properties: {}, required: [], additionalProperties: false });

  assert.throws(
    () => strictifyToolDefinitions([
      { type: "function", function: { name: "bad_tool", parameters: { type: "object", properties: { x: { oneOf: [{ type: "string" }] } } } } },
    ]),
    (error: unknown) => error instanceof DeepSeekStrictSchemaError && error.message.includes("bad_tool"),
  );
});

test("shouldUseStrictSchemas only for DeepSeek profiles", () => {
  assert.equal(shouldUseStrictSchemas(modelProfile({ family: "deepseek", model: "deepseek-chat" })), true);
  assert.equal(shouldUseStrictSchemas(modelProfile({ family: "glm", model: "glm-5.3" })), false);
  assert.equal(shouldUseStrictSchemas(modelProfile({ family: "kimi", model: "kimi-k3" })), false);
});
