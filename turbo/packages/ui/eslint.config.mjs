import { config, oxlint } from "@vm0/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
