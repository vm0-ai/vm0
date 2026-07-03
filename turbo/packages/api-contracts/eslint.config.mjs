import { config, oxlint } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["**/dist/**", "src/firewalls/*.generated.ts"],
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
