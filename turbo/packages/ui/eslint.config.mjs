import { config, oxlint } from "@okouai/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  // Public package entry points may aggregate implementation modules.
  {
    files: ["src/index.ts"],
    rules: {
      "okou/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
