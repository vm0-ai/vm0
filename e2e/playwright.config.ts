import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  globalSetup: "./global-setup.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: process.env.VM0_API_URL ?? "http://localhost:3000",
    ignoreHTTPSErrors: true,
  },
});
