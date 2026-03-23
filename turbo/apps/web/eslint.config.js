import { nextJsConfig } from "@vm0/eslint-config/next-js";
import webPlugin from "./custom-eslint/index.ts";

const classRestrictions = [
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
];

/** @type {import("eslint").Linter.Config} */
export default [
  ...nextJsConfig,
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        ...classRestrictions,
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Use env() from src/env.ts instead of process.env. Direct access bypasses validation and breaks test isolation.",
        },
      ],
    },
  },
  {
    files: [
      "src/env.ts",
      "src/lib/logger.ts",
      "drizzle.config.ts",
      "next.config.js",
      "scripts/**",
      "instrumentation.ts",
      "instrumentation-client.ts",
      "sentry.edge.config.ts",
      "sentry.server.config.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", ...classRestrictions],
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
    files: ["app/api/**/route.ts"],
    plugins: {
      web: webPlugin,
    },
    rules: {
      "web/no-request-json-as": "error",
      "web/no-self-api-call": "error",
    },
  },
  {
    // Legacy zero API routes that still use infra-client for HTTP round-trips.
    // These should be refactored to call underlying logic directly.
    files: ["app/api/zero/**/route.ts"],
    plugins: {
      web: webPlugin,
    },
    rules: {
      "web/no-self-api-call": "off",
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
