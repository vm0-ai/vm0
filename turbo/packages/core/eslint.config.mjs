import { config } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["**/dist/**"],
  },
  {
    // Sandbox scripts run in E2B/Firecracker VM, not in turbo build system.
    // Environment variables are injected by the sandbox orchestrator.
    files: ["**/sandbox/scripts/**/*.ts"],
    rules: {
      "turbo/no-undeclared-env-vars": "off",
    },
  },
];
