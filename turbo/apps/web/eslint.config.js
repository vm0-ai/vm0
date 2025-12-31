import { nextJsConfig } from "@vm0/eslint-config/next-js";

/** @type {import("eslint").Linter.Config} */
export default [
  ...nextJsConfig,
  {
    // Ignore test files from Next.js build linting - they use vitest types
    // which can slow down type checking in the build process
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx"],
  },
];
