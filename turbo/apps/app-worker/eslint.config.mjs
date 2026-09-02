import { config, oxlint } from "@okouai/eslint-config/base";

export default [
  { ignores: ["shell/**"] },
  ...config,
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
  {
    files: ["src/worker.js"],
    languageOptions: {
      globals: {
        fetch: "readonly",
        Headers: "readonly",
        HTMLRewriter: "readonly",
        Request: "readonly",
        Response: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      complexity: ["error", 25],
    },
  },
];
