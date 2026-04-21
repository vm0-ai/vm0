import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@clerk/clerk-react/experimental": path.resolve(
        __dirname,
        "./src/test/mocks/clerk-react-experimental.ts",
      ),
      "@clerk/clerk-react": path.resolve(
        __dirname,
        "./src/test/mocks/clerk-react.ts",
      ),
      // Mock ably in tests so setupRealtime$ creates a fake channel and
      // setAblyLoop$ uses the real subscribe/deferred code path.
      ably: path.resolve(__dirname, "./src/mocks/ably.ts"),
    },
  },
  define: {
    "import.meta.env.VITE_MOCK_LOG_DETAIL": JSON.stringify(""),
  },
  test: {
    globals: true,
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    maxWorkers: 4,
    minWorkers: 1,
  },
});
