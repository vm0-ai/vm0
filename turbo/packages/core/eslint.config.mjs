import { config } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    // Sandbox scripts run in E2B sandbox with their own runtime env vars
    // These are not turbo build-time env vars
    files: ["**/sandbox/scripts/src/**/*.ts"],
    rules: {
      "turbo/no-undeclared-env-vars": "off",
    },
  },
  {
    // Auto-generated bundled scripts and build output
    ignores: ["**/sandbox/scripts/scripts.ts", "**/sandbox/scripts/dist/**"],
  },
];
