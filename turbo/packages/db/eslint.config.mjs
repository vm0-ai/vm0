import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  ...config,
  {
    ignores: [
      "**/dist/**",
      "scripts/migrations/00*/**",
      "scripts/migrations/01[0-2]*/**",
    ],
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
