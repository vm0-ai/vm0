import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { signInThroughHostedAuth } from "../lib/auth";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";

test("sign in through onboarding handoff to chat page", async ({ page }) => {
  test.setTimeout(240_000);

  const email = process.env.E2E_CLERK_USER_EMAIL!;
  const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

  await clerkSetup();
  await setupClerkTestingToken({ page });

  await signInThroughHostedAuth(page, email, appUrl);

  // Navigate to app - should land on the onboarding handoff or agents
  await page.goto(appUrl);
  await page.waitForURL(
    (url) => {
      const p = url.pathname;
      return p.includes("/onboarding") || p.includes("/agents/");
    },
    { timeout: 30_000 },
  );

  // Follow the external onboarding handoff if needed.
  if (page.url().includes("/onboarding")) {
    await completeOnboardingThroughExploreOwn(page);
  }

  // Verify: landed on chat page
  await page.waitForURL("**/agents/*/chat", {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
  expect(page.url()).toMatch(/\/agents\/.*\/chat/);

  // Save storageState for feature tests (use absolute path to match playwright.config.ts)
  await page.context().storageState({ path: STORAGE_STATE });
});

async function completeOnboardingThroughExploreOwn(page: Page): Promise<void> {
  const exploreOwn = page.getByRole("radio", {
    name: /I will explore on my own/i,
  });
  await expect(exploreOwn).toBeVisible({ timeout: 60_000 });
  await exploreOwn.click();

  const continueButton = page.getByTestId("onboarding-next-button");
  await expect(continueButton).toBeEnabled({ timeout: 60_000 });

  const completionResponse = page.waitForResponse(
    (response) => {
      return (
        response.url().includes("/api/zero/onboarding/complete-limited-free") &&
        response.request().method() === "POST"
      );
    },
    { timeout: 60_000 },
  );
  await continueButton.click();

  const response = await completionResponse;
  if (response.status() !== 200) {
    throw new Error(
      `limited-free onboarding failed with ${response.status()}: ${await response.text()}`,
    );
  }
}
