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
    },
  },
  // Non-type-aware ccstate rules (exclude custom-eslint and signals/utils.ts)
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["custom-eslint/**", "src/signals/utils.ts"],
    rules: {
      "ccstate/signal-dollar-suffix": "error",
      "ccstate/no-export-state": "error",
      "ccstate/signal-check-await": "error",
      "ccstate/tsx-in-views": "error",
      "ccstate/no-catch-abort": "error",
      "ccstate/test-context-in-hooks": "error",
    },
  },
  // Type-aware rules (only for TypeScript files)
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: [
      "custom-eslint/**",
      "**/__tests__/**",
      "src/mocks/**",
      // Files with intentional module-scope mutable state
      "src/signals/location.ts",
      "src/signals/utils.ts",
      "src/signals/log.ts",
      "src/env.ts",
      "src/views/error-boundary.tsx",
      // Files that intentionally store/get AbortSignal from state
      "src/signals/page-signal.ts",
      "src/signals/root-signal.ts",
      "src/signals/route.ts",
      // Files that intentionally accept Store as parameter
      "src/main.ts",
      "src/views/main.tsx",
    ],
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
          ],
        },
      ],
      "ccstate/no-get-signal": "error",
      "ccstate/computed-const-args-package-scope": "error",
      "ccstate/no-store-in-params": "error",
    },
  },
  // Type-aware rules for files with intentional module-scope state
  {
    files: [
      "custom-eslint/**/*.ts",
      "**/__tests__/**/*.ts",
      "**/__tests__/**/*.tsx",
      "src/mocks/**/*.ts",
      "src/signals/location.ts",
      "src/signals/utils.ts",
      "src/signals/log.ts",
      "src/env.ts",
      "src/views/error-boundary.tsx",
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "ccstate/computed-const-args-package-scope": "error",
    },
  },
  // Type-aware rules for signal/store pattern files
  {
    files: [
      "src/signals/page-signal.ts",
      "src/signals/root-signal.ts",
      "src/signals/route.ts",
      "src/main.ts",
      "src/views/main.tsx",
    ],
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
          ],
        },
      ],
      "ccstate/computed-const-args-package-scope": "error",
    },
  },
  {
    ignores: ["dist/**", "vite.config.ts", "vitest.config.ts"],
  },
];
