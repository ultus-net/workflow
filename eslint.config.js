import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["test/fixtures/**/*.mjs"],
    languageOptions: {
      globals: { Buffer: "readonly", process: "readonly", console: "readonly", setTimeout: "readonly", WebSocket: "readonly" },
    },
  },
);
