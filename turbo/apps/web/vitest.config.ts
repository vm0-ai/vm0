import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: "./src/__tests__/setup.ts",
    // Don't override env vars, let them pass through from system
    // Run tests sequentially to avoid database race conditions
    fileParallelism: false,
    // Automatically clear mocks before each test (eliminates manual vi.clearAllMocks() calls)
    clearMocks: true,
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./src"),
    },
  },
});
