import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@clerk/react/experimental": path.resolve(
        __dirname,
        "./src/test/mocks/clerk-react-experimental.ts",
      ),
      "@clerk/react": path.resolve(
        __dirname,
        "./src/test/mocks/clerk-react.ts",
      ),
      // Mock ably in tests so setupRealtime$ creates a fake channel and
      // setAblyLoop$ uses the real subscribe/deferred code path.
      "ably/modular": path.resolve(__dirname, "./src/mocks/ably.ts"),
      ably: path.resolve(__dirname, "./src/mocks/ably.ts"),
      // Mock idb in tests so IndexedDB operations fall through to the
      // remote (MSW-mocked) path on openDB rejection in happy-dom.
      idb: path.resolve(__dirname, "./src/mocks/idb.ts"),
      // Stub Mermaid rendering in tests: the real renderer needs the SVG
      // measurement APIs of a browser layout engine, which happy-dom does not
      // implement. Parsing has no such needs, so the stub delegates it to the
      // real flowchart-only module via `mermaid-flowchart-real`.
      "@okouai/mermaid-flowchart": path.resolve(
        __dirname,
        "./src/mocks/mermaid.ts",
      ),
      "mermaid-flowchart-real": path.resolve(
        __dirname,
        "../../packages/mermaid-flowchart/dist/mermaid.esm.tiny.min.mjs",
      ),
      "virtual:shared-database-worker-inline": `${path.resolve(
        __dirname,
        "./src/shared-database-worker.ts",
      )}?sharedworker&inline`,
      "idb-real": path.resolve(__dirname, "./node_modules/idb/build/index.js"),
    },
  },
  define: {
    "import.meta.env.VITE_MOCK_LOG_DETAIL": JSON.stringify(""),
  },
  test: {
    coverage: {
      exclude: [
        "src/**/__tests__/**",
        "src/__tests__/**",
        "src/mocks/**",
        "src/test/**",
      ],
    },
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
    benchmark: {
      include: ["src/**/__benches__/**/*.bench.tsx"],
      includeSamples: true,
      reporters: ["default", "./scripts/bench-p90-reporter.ts"],
    },
  },
});
