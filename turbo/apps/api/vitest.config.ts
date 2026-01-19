import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { config } from "dotenv";
import { existsSync } from "fs";

// Load .env.local for tests if it exists (local development)
const envLocalPath = resolve(__dirname, ".env.local");
if (existsSync(envLocalPath)) {
  config({ path: envLocalPath });
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: "./src/test/setup.ts",
    // Don't override env vars, let them pass through from system
    // Run tests sequentially to avoid database race conditions
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./src"),
    },
  },
});
