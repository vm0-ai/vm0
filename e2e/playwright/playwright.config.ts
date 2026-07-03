import dotenv from "dotenv";
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

dotenv.config({ path: path.join(__dirname, "../.env.local") });

const apiUrl = process.env.VM0_API_URL;
if (!apiUrl) {
  throw new Error("VM0_API_URL environment variable is required");
}

export function deriveAppUrl(sourceUrl: string): string {
  if (process.env.VM0_APP_URL) {
    return process.env.VM0_APP_URL;
  }

  // Handle preview API/web URLs like pr-8510-api/www.vm6.ai and production
  // URLs like api/www.vm7.ai.
  return sourceUrl
    .replace(/-(api|www)\./, "-app.")
    .replace(/\/\/(api|www)\./, "//app.");
}

export const STORAGE_STATE = path.join(__dirname, ".auth/storage-state.json");
const appUrl = deriveAppUrl(apiUrl);

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup",
  globalTeardown: "./global-teardown",
  timeout: 120_000,
  use: {
    baseURL: appUrl,
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
      name: "paid-onboarding",
      testMatch: "paid-onboarding.spec.ts",
    },
    {
      name: "features",
      testMatch: [
        "agents.spec.ts",
        "chat.spec.ts",
        "create-agent.spec.ts",
        "billing-payment.spec.ts",
        "webchat.spec.ts",
        "workflows.spec.ts",
      ],
      dependencies: ["setup"],
      use: {
        storageState: STORAGE_STATE,
      },
    },
  ],
});
