import { config } from "@vm0/eslint-config/base";

export default [
  ...config,
  {
    ignores: ["**/dist/**"],
  },
  {
    // Sandbox scripts and build scripts run in Node.js environment.
    // Use separate tsconfig with Node.js types, disable projectService for these files.
    files: [
      "**/sandbox/scripts/src/**/*.ts",
      "**/sandbox/scripts/__tests__/**/*.ts",
      "scripts/**/*.ts",
    ],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.scripts.json",
      },
    },
    rules: {
      "turbo/no-undeclared-env-vars": "off",
    },
  },
];
