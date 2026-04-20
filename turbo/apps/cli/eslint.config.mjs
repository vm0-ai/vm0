import { config, oxlint } from "@vm0/eslint-config/base";

export default [
  ...config,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
