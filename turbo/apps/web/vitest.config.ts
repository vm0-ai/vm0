import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: "./src/__tests__/global-setup.ts",
    setupFiles: "./src/__tests__/setup.ts",
    // Don't override env vars, let them pass through from system
    // Automatically clear mocks before each test (eliminates manual vi.clearAllMocks() calls)
    clearMocks: true,
    // Automatically restore all env stubs after each test (prevents cross-test leakage)
    unstubEnvs: true,
  },
  oxc: {
    // Use automatic JSX runtime so .tsx files don't require `import React`
    // (Vite 8 uses oxc transformer by default; esbuild config is ignored)
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./src"),
    },
  },
});
