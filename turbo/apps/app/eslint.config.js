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
      "ccstate/signal-dollar-suffix": "error",
      "ccstate/no-export-state": "error",
      "ccstate/signal-check-await": "error",
      "ccstate/tsx-in-views": "error",
    },
  },
  {
    ignores: ["dist/**"],
  },
];
