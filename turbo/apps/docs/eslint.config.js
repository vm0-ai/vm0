import { nextJsConfig, oxlint } from "@vm0/eslint-config/next-js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...nextJsConfig,
  {
    ignores: [".source/**/*"],
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
