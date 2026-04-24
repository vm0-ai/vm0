import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vitest/config";

const sharedBrowserExecutablePath = process.env.AGENT_BROWSER_EXECUTABLE_PATH;

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["@clerk/clerk-js"],
  },
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
      ably: path.resolve(__dirname, "./src/mocks/ably.ts"),
    },
  },
  define: {
    "import.meta.env.VITE_MOCK_LOG_DETAIL": JSON.stringify(""),
  },
  test: {
    globals: true,
    include: ["src/**/*.btest.{ts,tsx}"],
    setupFiles: ["./src/test/browser-setup.ts"],
    restoreMocks: true,
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    browser: {
      enabled: true,
      provider: playwright(
        sharedBrowserExecutablePath
          ? {
              launchOptions: {
                executablePath: sharedBrowserExecutablePath,
                args: ["--no-sandbox"],
              },
            }
          : undefined,
      ),
      headless: true,
      instances: [{ browser: "chromium" }],
      viewport: {
        width: 1280,
        height: 900,
      },
      screenshotFailures: false,
    },
  },
});
