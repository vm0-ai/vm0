import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { signInThroughHostedAuth } from "../lib/auth";
import {
  completeExploreOnboarding,
  deriveOnboardingUrl,
} from "../lib/onboarding";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";

test("sign in through onboarding handoff to chat page", async ({ page }) => {
  test.setTimeout(240_000);

  const email = process.env.E2E_CLERK_USER_EMAIL!;
  const orgId = process.env.E2E_CLERK_ORG_ID!;
  const apiUrl = process.env.VM0_API_URL!;
  const appUrl = deriveAppUrl(apiUrl);
  const onboardingUrl = deriveOnboardingUrl(apiUrl);

  await clerkSetup();
  await setupClerkTestingToken({ page });

  await signInThroughHostedAuth(page, email, appUrl, {
    followRedirect: false,
    activeOrganizationId: orgId,
    mirrorStorageToUrls: [onboardingUrl],
  });

  await completeExploreOnboarding(page, { apiUrl, appUrl, onboardingUrl });

  // Verify: landed on chat page
  await page.waitForURL("**/agents/*/chat", {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
  expect(page.url()).toMatch(/\/agents\/.*\/chat/);

  // Save storageState for feature tests (use absolute path to match playwright.config.ts)
  await page.context().storageState({ path: STORAGE_STATE });
});
