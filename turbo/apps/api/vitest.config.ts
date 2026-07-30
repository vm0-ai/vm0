import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    env: {
      INDONESIAN_LOCALE_ROLLOUT_ENABLED: "true",
      TZ: "UTC",
    },
    setupFiles: ["./src/__tests__/env-stub.ts", "./src/__tests__/setup.ts"],
    exclude: ["node_modules/**", "dist/**", "**/__benches__/**"],
    benchmark: {
      include: ["src/**/__benches__/**/*.bench.ts"],
      includeSamples: true,
      reporters: ["default", "./scripts/bench-p90-reporter.ts"],
    },
  },
});
