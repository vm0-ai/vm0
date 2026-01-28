import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    // Suppress console output from passing tests to reduce noise
    // Logs from failing tests are still displayed for debugging
    silent: "passed-only",

    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/**",
        "**/*.config.*",
        "**/coverage/**",
        "**/*.d.ts",
        "**/*.spec.{ts,tsx,js,jsx}",
        "**/*.test.{ts,tsx,js,jsx}",
        "**/__tests__/**",
        "**/.next/**",
        "**/dist/**",
        "packages/eslint-config/*.js",
      ],
    },

    reporters: process.env.CI ? ["default", "github-actions"] : ["default"],

    projects: ["packages/*", "apps/*"],
  },
});
