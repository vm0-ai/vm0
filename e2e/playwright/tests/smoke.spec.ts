import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { signInThroughHostedAuth } from "../lib/auth";
import {
  authHeadersForToken,
  seedLimitedFreeBillingState,
  setupOnboarding,
} from "../lib/onboarding";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";

test("sign in through onboarding handoff to chat page", async ({ page }) => {
  test.setTimeout(240_000);

  const email = process.env.E2E_CLERK_USER_EMAIL!;
  const orgId = process.env.E2E_CLERK_ORG_ID!;
  const apiUrl = process.env.VM0_API_URL!;
  const appUrl = deriveAppUrl(apiUrl);

  await clerkSetup();
  await setupClerkTestingToken({ page });

  const session = await signInThroughHostedAuth(page, email, appUrl, {
    followRedirect: false,
    activeOrganizationId: orgId,
  });
  const headers = authHeadersForToken(session.token);
  await setupOnboarding(page, apiUrl, headers, {
    displayName: "E2E Test Agent",
    workspaceName: "E2E Test Workspace",
    selectedConnectors: [],
    timezone: "UTC",
  });
  await seedLimitedFreeBillingState(page, apiUrl, orgId);

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
