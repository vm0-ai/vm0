import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: process.env.DATABASE_URL
      ? configDefaults.exclude
      : [...configDefaults.exclude, "src/__tests__/migrations/**/*.test.ts"],
  },
});
