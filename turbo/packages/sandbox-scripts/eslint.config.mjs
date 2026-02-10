import { config } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["**/dist/**"],
  },
  {
    // This entire package contains sandbox scripts and their tests.
    // Environment variables are injected by the sandbox orchestrator.
    files: ["src/**/*.ts"],
    rules: {
      "turbo/no-undeclared-env-vars": "off",
    },
  },
];
