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
      // Mock idb in tests so IndexedDB operations fall through to the
      // remote (MSW-mocked) path on openDB rejection in happy-dom.
      idb: path.resolve(__dirname, "./src/mocks/idb.ts"),
    },
  },
  define: {
    "import.meta.env.VITE_MOCK_LOG_DETAIL": JSON.stringify(""),
  },
  test: {
    globals: true,
    environment: "happy-dom",
    environmentOptions: {
      happyDOM: {
        settings: {
          // Prevent happy-dom from making real TCP connections for iframe src
          // URLs. With this enabled, #loadPage() returns immediately with a
          // NotSupportedError instead of initiating a network request. The
          // error is suppressed in setup.ts.
          disableIframePageLoading: true,
        },
      },
    },
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
