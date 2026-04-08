import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

if (!process.env.VM0_API_URL) {
  throw new Error("VM0_API_URL environment variable is required");
}

export const STORAGE_STATE = path.join(__dirname, ".clerk", "user.json");

export function deriveAppUrl(webUrl: string): string {
  // Handle preview URLs like https://pr-8510-www.vm6.ai -> https://pr-8510-app.vm6.ai
  // and production URLs like https://www.vm7.ai -> https://app.vm7.ai
  return webUrl.replace(/-www\./, "-app.").replace(/\/\/www\./, "//app.");
}

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup",
  globalTeardown: "./global-teardown",
  use: {
    baseURL: process.env.VM0_API_URL,
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },
    {
      name: "features",
      testMatch: /.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE,
      },
      dependencies: ["setup"],
    },
  ],
});
