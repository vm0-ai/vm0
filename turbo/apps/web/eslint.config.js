import { nextJsConfig, oxlint } from "@vm0/eslint-config/next-js";
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
      // react-hooks v7 added many rules via configs.recommended with extreme runtime cost.
      // Keep only the two classic rules; disable all v7 additions.
      "react-hooks/static-components": "off",
      "react-hooks/use-memo": "off",
      "react-hooks/component-hook-factories": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/incompatible-library": "off",
      "react-hooks/immutability": "off",
      "react-hooks/globals": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/error-boundaries": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-render": "off",
      "react-hooks/unsupported-syntax": "off",
      "react-hooks/config": "off",
      "react-hooks/gating": "off",
      // Covered by oxlint (react/rules-of-hooks, react/no-direct-mutation-state,
      // react/display-name, react/require-render-return)
      "react-hooks/rules-of-hooks": "off",
      "react/no-direct-mutation-state": "off",
      "react/display-name": "off",
      "react/require-render-return": "off",
      // Class component rules — irrelevant, classes are banned in this codebase
      "react/prop-types": "off",
      "react/no-deprecated": "off",
    },
  },
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
      "src/lib/shared/logger.ts",
      "src/__tests__/global-setup.ts",
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
    files: ["**/api-test-helpers/**/*.ts"],
    plugins: {
      web: webPlugin,
    },
    rules: {
      "web/no-direct-db-in-tests": "error",
    },
  },
  {
    ignores: [
      "custom-eslint/**",
      "scripts/migrations/001-backfill-clerk-orgs/**",
      "scripts/migrations/002-backfill-clerk-metadata/**",
      "scripts/migrations/003-sync-clerk-slugs/**",
      "scripts/migrations/004-backfill-default-agent/**",
      "scripts/migrations/005-backfill-clerk-metadata/**",
      "scripts/migrations/006-cleanup-orphaned-orgs/**",
    ],
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
