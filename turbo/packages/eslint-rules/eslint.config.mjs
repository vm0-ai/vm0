import { config, oxlint } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["**/dist/**"],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "arrow-body-style": "off",
      complexity: "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
