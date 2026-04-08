import dotenv from "dotenv";
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

dotenv.config({ path: path.join(__dirname, "../.env.local") });

if (!process.env.VM0_API_URL) {
  throw new Error("VM0_API_URL environment variable is required");
}

export function deriveAppUrl(webUrl: string): string {
  // Handle preview URLs like https://pr-8510-www.vm6.ai -> https://pr-8510-app.vm6.ai
  // and production URLs like https://www.vm7.ai -> https://app.vm7.ai
  return webUrl.replace(/-www\./, "-app.").replace(/\/\/www\./, "//app.");
}

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup",
  globalTeardown: "./global-teardown",
  timeout: 120_000,
  use: {
    baseURL: process.env.VM0_API_URL,
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
});
