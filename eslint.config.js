import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Flat config (ESLint v9+). Order matters: the Prettier preset is last so it can
// switch off any stylistic rules that would fight `prettier --write`.
export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // TypeScript's own checker resolves identifiers far more accurately than the
    // lexical `no-undef` rule, which only produces false positives on typed code.
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
      // Honor the leading-underscore convention for deliberately unused bindings
      // (e.g. a fake `fetch(_url, _init)` that ignores its arguments).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);
