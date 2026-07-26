import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "../fixtures";
import { refreshClerkSessionToken, signInThroughHostedAuth } from "../lib/auth";
import { completeExploreOnboarding } from "../lib/onboarding";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";

test("complete app onboarding to chat page", async ({ browser, page }) => {
  test.setTimeout(240_000);

  const email = process.env.E2E_CLERK_USER_EMAIL!;
  const orgId = process.env.E2E_CLERK_ORG_ID!;
  const apiUrl = process.env.VM0_API_BACKEND_URL!;
  const appUrl = deriveAppUrl(apiUrl);

  await signInThroughHostedAuth(page, email, appUrl, {
    followRedirect: false,
    activeOrganizationId: orgId,
  });

  await completeExploreOnboarding(page, {
    appUrl,
  });

  // Verify: landed on chat page
  await page.waitForURL("**/agents/*/chat", {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
  expect(page.url()).toMatch(/\/agents\/.*\/chat/);

  await refreshClerkSessionToken(page, { activeOrganizationId: orgId });

  // Save storageState for feature tests (use absolute path to match playwright.config.ts)
  await page.context().storageState({ path: STORAGE_STATE });

  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const verificationContext = await browser.newContext({
    storageState: STORAGE_STATE,
    extraHTTPHeaders: bypassSecret
      ? { "x-vercel-protection-bypass": bypassSecret }
      : undefined,
    ignoreHTTPSErrors: true,
  });
  try {
    await setupClerkTestingToken({ context: verificationContext });
    const verificationPage = await verificationContext.newPage();
    await verificationPage.goto(`${appUrl}/agents`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      verificationPage.getByRole("heading", { name: "Agents" }),
    ).toBeVisible({ timeout: 20_000 });
    await verificationPage.waitForFunction(
      (organizationId) => window.Clerk?.organization?.id === organizationId,
      orgId,
      { timeout: 30_000 },
    );
  } finally {
    await verificationContext.close();
  }
});
