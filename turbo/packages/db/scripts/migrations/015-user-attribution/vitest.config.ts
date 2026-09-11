import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["scripts/migrations/015-user-attribution/backfill.test.ts"],
  },
});
