import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["test/fixtures/**/*.mjs", "test/fixtures/**/*.cjs"],
    languageOptions: {
      globals: { Buffer: "readonly", process: "readonly", console: "readonly", setTimeout: "readonly", WebSocket: "readonly", URL: "readonly" },
    },
  },
  {
    // C2: the vendored guard-policy copy is byte-identical to the vendored
    // app's source (enforced by test/guard-policy-drift.test.ts). The app's
    // own eslint config tolerates two intentionally-unused locals; lint-fixing
    // them here would break byte-identity, so the copy is exempt from the
    // repo's no-unused-vars rule. Never apply code changes inside this dir —
    // regenerate the copies instead.
    files: ["src/integrations/guard-policy/**/*.ts"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
);
