import { config, oxlint } from "@okouai/eslint-config/base";

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
  // Public package entry points may aggregate implementation modules.
  {
    files: ["src/index.ts"],
    rules: {
      "vm0/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
