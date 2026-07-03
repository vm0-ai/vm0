import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { refreshClerkSessionToken, signInThroughHostedAuth } from "../lib/auth";
import { routeOnboardingApiToPreview } from "../lib/onboarding";
import {
  deriveAppUrl,
  deriveOnboardingUrl,
  deriveServiceOrigin,
  STORAGE_STATE,
} from "../playwright.config";

test("sign in through onboarding handoff to chat page", async ({ page }) => {
  test.setTimeout(240_000);

  const email = process.env.E2E_CLERK_USER_EMAIL!;
  const orgId = process.env.E2E_CLERK_ORG_ID!;
  const apiUrl = process.env.VM0_API_URL!;
  const appUrl = deriveAppUrl(apiUrl);
  const onboardingUrl = deriveOnboardingUrl(apiUrl);
  const onboardingAuthAppUrl = deriveServiceOrigin(onboardingUrl, "app");
  const onboardingApiUrl = deriveServiceOrigin(onboardingUrl, "api");

  await clerkSetup();
  await setupClerkTestingToken({ page });

  const session = await signInThroughHostedAuth(
    page,
    email,
    onboardingAuthAppUrl,
    {
      followRedirect: false,
      activeOrganizationId: orgId,
      mirrorStorageToUrls: [onboardingUrl, onboardingApiUrl, appUrl],
    },
  );
  await routeOnboardingApiToPreview(page, onboardingUrl, apiUrl, {
    authorizationToken: session.token,
  });
  await page.goto(onboardingUrl, { waitUntil: "domcontentloaded" });
  await refreshClerkSessionToken(page, { activeOrganizationId: orgId });
  await completeOnboardingThroughExploreOwn(page);
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });

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
    throw new Error(`limited-free onboarding failed with ${response.status()}`);
  }
}
