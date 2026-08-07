import { config, oxlint } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["**/dist/**"],
  },
  {
    files: ["src/index.ts", "src/node.ts"],
    rules: {
      "vm0/no-re-export": "off",
    },
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
];
