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

export const STORAGE_STATE = path.join(__dirname, ".auth/storage-state.json");

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
  projects: [
    {
      name: "setup",
      testMatch: "smoke.spec.ts",
    },
    {
      name: "features",
      testMatch: [
        "agents.spec.ts",
        "schedule.spec.ts",
        "chat.spec.ts",
        "create-agent.spec.ts",
        "create-schedule.spec.ts",
        "webchat.spec.ts",
      ],
      dependencies: ["setup"],
      use: {
        storageState: STORAGE_STATE,
      },
    },
  ],
});
