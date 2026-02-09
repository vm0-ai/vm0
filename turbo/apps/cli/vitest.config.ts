import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __CLI_VERSION__: JSON.stringify("0.0.0-test"),
    __DEFAULT_SENTRY_DSN__: JSON.stringify(""),
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
  },
});
