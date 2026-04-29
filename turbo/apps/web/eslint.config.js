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
      // react-hooks v7 added many rules via configs.recommended with significant runtime cost.
      // The rules below are disabled because they either have no violations in this codebase
      // or are superseded by oxlint equivalents (see .oxlintrc.json).
      //
      // Rules moved to oxlint (react plugin) — same semantics, Rust-based for speed.
      // Verified: oxlint react/rules-of-hooks catches conditional hook violations.
      // Note: oxlint uses "react/" namespace while ESLint uses "react-hooks/" — both enforce
      // the same React hooks constraint specification.
      "react-hooks/rules-of-hooks": "off",
      // Class component rules — irrelevant, classes are banned via no-restricted-syntax
      "react/no-direct-mutation-state": "off",
      "react/display-name": "off",
      "react/require-render-return": "off",
      "react/prop-types": "off",
      "react/no-deprecated": "off",
      // react-hooks v7 rules disabled for performance. Rationale per rule:
      // static-components: no violations; functional component pattern is consistent
      "react-hooks/static-components": "off",
      // use-memo: high cost, no violations; memoization decisions are reviewed manually
      "react-hooks/use-memo": "off",
      // component-hook-factories: no violations in codebase
      "react-hooks/component-hook-factories": "off",
      // preserve-manual-memoization: no violations; conflicts with use-memo being off
      "react-hooks/preserve-manual-memoization": "off",
      // incompatible-library: no third-party hook libraries that trigger this
      "react-hooks/incompatible-library": "off",
      // immutability: enforced by TypeScript readonly types and code review
      "react-hooks/immutability": "off",
      // globals: no violations; React globals usage is consistent
      "react-hooks/globals": "off",
      // refs: no violations; ref usage patterns are reviewed
      "react-hooks/refs": "off",
      // set-state-in-effect: no violations; effect cleanup patterns are consistent
      "react-hooks/set-state-in-effect": "off",
      // error-boundaries: classes are banned, so error boundary class components don't exist
      "react-hooks/error-boundaries": "off",
      // purity: no violations; side effects are intentional and reviewed
      "react-hooks/purity": "off",
      // set-state-in-render: re-enabled to prevent infinite render loops
      // (setState during render causes immediate re-render, leading to infinite loops)
      "react-hooks/set-state-in-render": "error",
      // unsupported-syntax: no violations; no experimental syntax used
      "react-hooks/unsupported-syntax": "off",
      // config: no violations; no react compiler config directives used
      "react-hooks/config": "off",
      // gating: no violations; no feature flag gating of hooks used
      "react-hooks/gating": "off",
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
      // Ban new globals — the globalThis.services pattern is the only sanctioned one
      "web/no-global-assignment": "error",
    },
  },
  {
    files: ["app/api/**/route.ts"],
    plugins: {
      web: webPlugin,
    },
    rules: {
      "web/no-new-api-routes": "error",
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
      "public/**",
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
