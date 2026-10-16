import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
      ".azure/**",
      "splitwise-data/**"
    ]
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    extends: [js.configs.recommended],
    linterOptions: { reportUnusedDisableDirectives: "error" }
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }]
    }
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: { "react-hooks/exhaustive-deps": "error" }
  },
  {
    files: ["*.{js,ts}", "api/**/*.ts", "tests/**/*.ts", "**/*.test.ts"],
    languageOptions: { globals: globals.node }
  }
);
