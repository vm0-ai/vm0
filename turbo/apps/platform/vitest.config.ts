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
    },
  },
  test: {
    globals: true,
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
