import { config as baseConfig, oxlint } from "@vm0/eslint-config/base";
import pluginReactHooks from "eslint-plugin-react-hooks";
import pluginReact from "eslint-plugin-react";
import ccstatePlugin from "./custom-eslint/index.ts";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...baseConfig,
  {
    ...pluginReact.configs.flat.recommended,
    settings: { react: { version: "detect" } },
  },
  {
    plugins: {
      "react-hooks": pluginReactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    plugins: {
      ccstate: ccstatePlugin,
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      // Non-type-aware rules
      "ccstate/signal-dollar-suffix": "error",
      "ccstate/no-export-state": "error",
      "ccstate/signal-check-await": "error",
      "ccstate/tsx-in-views": "error",
      "ccstate/no-catch-abort": "error",
      "ccstate/test-context-in-hooks": "error",
      "ccstate/setup-page-render": "error",
      "ccstate/no-side-effect-in-render": "error",
      "ccstate/no-use-ccstate-in-views": "error",
      "ccstate/no-non-zero-api": "error",
      "ccstate/no-new-abort-controller": "error",
    },
  },
  // Type-aware rules (only for TypeScript files)
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "ccstate/no-package-variable": [
        "error",
        {
          allowedMutableTypes: [
            { from: "package", name: "State", package: "ccstate" },
            { from: "package", name: "Computed", package: "ccstate" },
            { from: "package", name: "Command", package: "ccstate" },
            { from: "file", name: "ConsoleLogger" },
            { from: "file", name: "TestContext" },
            { from: "package", name: "Store", package: "ccstate" },
            { from: "file", name: "LocationOverrides" },
            { from: "file", name: "PromiseTracker" },
            { from: "file", name: "LoggerRegistry" },
          ],
        },
      ],
      "ccstate/no-get-signal": "error",
      "ccstate/computed-const-args-package-scope": "error",
      "ccstate/no-store-in-params": "error",
      "ccstate/command-async-signal": "error",
      "ccstate/no-getter-setter-params": "error",
    },
  },
  {
    files: ["**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "ccstate/prefer-user-event": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name=/^(it|test)$/][arguments.2.type='Literal']",
          message:
            "Do not set test timeout. The default timeout (5000ms) is sufficient — a single test should complete within 500ms. Polling intervals are reduced to 10ms in tests, so do not rely on extending timeout to fix flaky tests. Find and fix the underlying timing issue instead.",
        },
        {
          selector:
            "CallExpression[callee.name='describe'][arguments.2.type='Literal']",
          message:
            "Do not set test timeout. The default timeout (5000ms) is sufficient — a single test should complete within 500ms. Polling intervals are reduced to 10ms in tests, so do not rely on extending timeout to fix flaky tests. Find and fix the underlying timing issue instead.",
        },
        {
          selector:
            "CallExpression[callee.name='waitFor'] > ObjectExpression > Property[key.name='timeout']",
          message:
            "Do not set test timeout. The default timeout (5000ms) is sufficient — a single test should complete within 500ms. Polling intervals are reduced to 10ms in tests, so do not rely on extending timeout to fix flaky tests. Find and fix the underlying timing issue instead.",
        },
      ],
    },
  },
  // Allow new AbortController in signal infrastructure, test helpers, and
  // views that need a controller outliving the page signal (e.g. post-navigate
  // async work).
  {
    files: [
      "src/signals/utils.ts",
      "src/polyfill.ts",
      "src/signals/__tests__/test-helpers.ts",
      "src/signals/__tests__/utils.test.ts",
      "src/signals/zero-page/__tests__/poll-slack-connection.test.ts",
      "src/views/zero-page/zero-onboarding.tsx",
    ],
    rules: {
      "ccstate/no-new-abort-controller": "off",
    },
  },
  {
    ignores: [
      "dist/**",
      "vite.config.ts",
      "vitest.config.ts",
      "custom-eslint/**",
      "src/mocks/**",
      "src/__tests__/**",
    ],
  },
  ...oxlint.buildFromOxlintConfigFile("../../.oxlintrc.json"),
];
