import { config as baseConfig } from "@vm0/eslint-config/base";
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
      ccstate: ccstatePlugin,
    },
    rules: {
      ...pluginReactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      // Non-type-aware rules
      "ccstate/signal-dollar-suffix": "error",
      "ccstate/no-export-state": "error",
      "ccstate/signal-check-await": "error",
      "ccstate/tsx-in-views": "error",
      "ccstate/no-catch-abort": "error",
      "ccstate/test-context-in-hooks": "error",
      "ccstate/setup-page-render": "error",
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
          ],
        },
      ],
      "ccstate/no-get-signal": "error",
      "ccstate/computed-const-args-package-scope": "error",
      "ccstate/no-store-in-params": "error",
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
];
