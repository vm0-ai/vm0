import { config, oxlint } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["**/dist/**", "scripts/migrations/**"],
  },
  // Public package entry points may aggregate implementation modules.
  {
    files: ["src/schema/*.ts"],
    rules: {
      "vm0/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
