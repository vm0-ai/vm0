import { clerk } from "@clerk/testing/playwright";
import { expect, test as setup } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { STORAGE_STATE, deriveAppUrl } from "./playwright.config";

const CREDENTIALS_PATH = path.join(__dirname, ".clerk", "credentials.json");

setup("authenticate and complete onboarding", async ({ page }) => {
  setup.setTimeout(120_000);
  const raw = await readFile(CREDENTIALS_PATH, "utf-8");
  const { email, password } = JSON.parse(raw) as {
    email: string;
    password: string;
  };

  const apiUrl = process.env.VM0_API_URL;
  if (!apiUrl) throw new Error("VM0_API_URL environment variable is required");
  const appUrl = deriveAppUrl(apiUrl);

  await page.goto(appUrl);

  await clerk.signIn({
    page,
    signInParams: {
      strategy: "password",
      identifier: email,
      password,
    },
  });

  // Navigate to app URL after sign-in (Clerk may redirect to www domain)
  await page.goto(appUrl);

  // Complete onboarding if present
  await completeOnboarding(page);

  // Wait for chat page
  await page.waitForURL("**/agents/*/chat", { timeout: 90_000 });
  await expect(page.getByText("Ask me to automate workflows")).toBeVisible({
    timeout: 90_000,
  });

  await page.context().storageState({ path: STORAGE_STATE });
});

async function completeOnboarding(
  page: import("@playwright/test").Page
): Promise<void> {
  // Check if already on chat page (already onboarded)
  if (page.url().includes("/agents/") && page.url().includes("/chat")) {
    return;
  }

  // Step 1: Name your workspace
  const workspaceInput = page.getByPlaceholder("e.g. Acme Corp");
  if (await workspaceInput.isVisible({ timeout: 5_000 })) {
    await workspaceInput.fill("E2E Test Workspace");
    await page.getByRole("button", { name: "Next" }).click();
  }

  // Step 2: Choose your tools — skip
  const chooseTools = page.getByTestId("onboarding-step-select-connectors");
  if (await chooseTools.isVisible({ timeout: 5_000 })) {
    await page.getByRole("button", { name: "Next" }).click();
  }

  // Step 3: Connect your apps — skip
  const connectApps = page.getByText("Connect your apps");
  if (await connectApps.isVisible({ timeout: 5_000 })) {
    await page.getByRole("button", { name: "Next" }).click();
  }

  // Step 4: Where to work — continue in web
  const continueWeb = page.getByRole("button", { name: "Continue in web" });
  if (await continueWeb.isVisible({ timeout: 5_000 })) {
    await continueWeb.click();
  }
}
