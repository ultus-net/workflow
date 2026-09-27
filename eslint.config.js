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
);
