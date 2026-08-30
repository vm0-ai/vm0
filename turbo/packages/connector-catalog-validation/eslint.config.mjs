import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  ...config,
  {
    files: ["src/**/*.ts"],
    rules: {
      "vm0/no-abort-signal-in-object-params": "error",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
