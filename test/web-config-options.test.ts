import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfigOptions } from "../src/ui/web-config-options.js";

test("normalizeConfigOptions returns an empty list for missing or malformed config", () => {
  assert.deepEqual(normalizeConfigOptions(undefined), []);
  assert.deepEqual(normalizeConfigOptions({}), []);
  assert.deepEqual(normalizeConfigOptions({ configOptions: "nope" }), []);
  assert.deepEqual(normalizeConfigOptions({ configOptions: [null, 42, "x", {}] }), []);
});

test("normalizeConfigOptions keeps well-formed select and boolean options", () => {
  const options = normalizeConfigOptions({
    configOptions: [
      {
        id: "model",
        name: "Model",
        description: "Which model to run",
        category: "model",
        type: "select",
        currentValue: "kimi-k2",
        options: [
          { value: "kimi-k2", name: "Kimi K2" },
          { value: "moonshot-v1", name: "Moonshot v1", description: "legacy" },
        ],
      },
      {
        id: "web-search",
        name: "Web search",
        category: "tools",
        type: "boolean",
        currentValue: true,
      },
      {
        id: "effort",
        type: "select",
        currentValue: "high",
        options: [{ value: "low" }, { value: "high" }],
      },
    ],
  });

  assert.equal(options.length, 3);
  assert.deepEqual(options[0], {
    id: "model",
    name: "Model",
    description: "Which model to run",
    category: "model",
    type: "select",
    currentValue: "kimi-k2",
    choices: [
      { value: "kimi-k2", name: "Kimi K2" },
      { value: "moonshot-v1", name: "Moonshot v1", description: "legacy" },
    ],
  });
  assert.equal(options[1]?.currentValue, true);
  // Missing name falls back to the id; missing choice name falls back to the value.
  assert.equal(options[2]?.name, "effort");
  assert.deepEqual(options[2]?.choices, [{ value: "low", name: "low" }, { value: "high", name: "high" }]);
});

test("normalizeConfigOptions drops options with wrong-typed values or empty choices", () => {
  const options = normalizeConfigOptions({
    configOptions: [
      { id: "bad-bool", type: "boolean", currentValue: "yes" },
      { id: "bad-select", type: "select", currentValue: true, options: [{ value: "a" }] },
      { id: "empty-select", type: "select", currentValue: "a", options: [] },
      { id: "bad-choice", type: "select", currentValue: "a", options: [{ name: "no value" }] },
      { id: "unknown-type", type: "slider", currentValue: 5 },
      { id: "ok", type: "boolean", currentValue: false },
    ],
  });
  assert.deepEqual(options.map((option) => option.id), ["ok"]);
});
