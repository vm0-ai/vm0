import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["**/dist/**", "scripts/migrations/**"],
  },
  // Public package entry points may aggregate implementation modules.
  {
    files: ["src/schema/*.ts"],
    rules: {
      "okou/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
