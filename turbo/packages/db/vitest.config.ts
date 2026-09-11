import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // The migration-consistency job supplies PostgreSQL for this suite.
    exclude: [
      ...configDefaults.exclude,
      "scripts/migrations/015-user-attribution/backfill.test.ts",
    ],
  },
});
