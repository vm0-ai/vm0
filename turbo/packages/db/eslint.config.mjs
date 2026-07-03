import { config, oxlint } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["**/dist/**", "scripts/migrations/**"],
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
