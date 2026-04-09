import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,

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

    reporters: process.env.CI
      ? ["default", "github-actions", "junit"]
      : ["default"],

    outputFile: {
      junit: "junit.xml",
    },

    projects: ["packages/*", "apps/*"],
  },
});
