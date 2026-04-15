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
      // Resolve ably via the stable pnpm virtual store path.
      // Vitest does not read tsconfig paths, so an explicit alias is required.
      ably: path.resolve(
        __dirname,
        "../../node_modules/.pnpm/node_modules/ably",
      ),
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
  },
});
