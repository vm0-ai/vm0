import { nextJsConfig } from "@vm0/eslint-config/next-js";
import webPlugin from "./custom-eslint/index.ts";

/** @type {import("eslint").Linter.Config} */
export default [
  ...nextJsConfig,
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ClassDeclaration",
          message:
            "Classes are not allowed. Use functions and plain objects instead.",
        },
        {
          selector: "ClassExpression",
          message:
            "Classes are not allowed. Use functions and plain objects instead.",
        },
      ],
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      web: webPlugin,
    },
    rules: {
      // Check for duplicate migration prefixes (runs once per lint process)
      "web/no-duplicate-migration-prefix": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    plugins: {
      web: webPlugin,
    },
    rules: {
      "web/no-direct-db-in-tests": "error",
      "web/no-relative-vi-mock": "error",
    },
  },
  {
    ignores: ["custom-eslint/**"],
  },
];
