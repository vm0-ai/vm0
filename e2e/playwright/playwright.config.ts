import dotenv from "dotenv";
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

dotenv.config({ path: path.join(__dirname, "../.env.local") });

const apiUrl = process.env.VM0_API_URL;
if (!apiUrl) {
  throw new Error("VM0_API_URL environment variable is required");
}

type PublicService = "api" | "app" | "www";

const SERVICE_LABELS = ["api", "app", "www"] as const;

export function deriveServiceOrigin(
  sourceUrl: string,
  service: PublicService,
): string {
  const url = new URL(sourceUrl);
  const labels = url.hostname.split(".");
  const firstLabel = labels[0];
  if (!firstLabel) {
    return url.origin;
  }

  if (SERVICE_LABELS.some((label) => label === firstLabel)) {
    labels[0] = service;
  } else {
    for (const label of SERVICE_LABELS) {
      const suffix = `-${label}`;
      if (firstLabel.endsWith(suffix)) {
        labels[0] = `${firstLabel.slice(0, -label.length)}${service}`;
        break;
      }
    }
  }

  url.hostname = labels.join(".");
  return url.origin;
}

export function deriveAppUrl(sourceUrl: string): string {
  return process.env.VM0_APP_URL ?? deriveServiceOrigin(sourceUrl, "app");
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
        "automation.spec.ts",
        "chat.spec.ts",
        "create-agent.spec.ts",
        "create-automation.spec.ts",
        "billing-payment.spec.ts",
        "webchat.spec.ts",
      ],
      dependencies: ["setup"],
      use: {
        storageState: STORAGE_STATE,
      },
    },
  ],
});
