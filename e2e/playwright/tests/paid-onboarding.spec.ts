import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { signInThroughHostedAuth } from "../lib/auth";
import {
  createOrganization,
  createUser,
  deleteUserByEmail,
  generateTestEmail,
} from "../lib/clerk-api";
import {
  authHeadersForToken,
  completeCheckout,
  createProTrialCheckout,
  setupOnboarding,
  waitForBillingSessionRedirect,
} from "../lib/onboarding";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import { deriveAppUrl } from "../playwright.config";

test("paid onboarding completes through the video workflow", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const apiUrl = process.env.VM0_API_URL!;
  const appUrl = deriveAppUrl(apiUrl);
  const email = generateTestEmail();

  try {
    const userId = await createUser(email);
    const orgId = await createOrganization("E2E Paid Onboarding Org", userId);

    await clerkSetup();
    await setupClerkTestingToken({ page });
    const session = await signInThroughHostedAuth(page, email, appUrl, {
      followRedirect: false,
      activeOrganizationId: orgId,
    });
    const headers = authHeadersForToken(session.token);
    await setupOnboarding(page, apiUrl, headers, {
      displayName: "E2E Video Agent",
      workspaceName: "E2E Paid Onboarding Workspace",
      selectedConnectors: [],
      timezone: "UTC",
      role: "video production",
    });

    const checkoutUrl = await createProTrialCheckout(
      page,
      apiUrl,
      appUrl,
      headers,
    );
    await page.goto(checkoutUrl, { waitUntil: "domcontentloaded" });

    const billingSessionIdPromise = waitForBillingSessionRedirect(page, appUrl);
    await fillStripeCheckout(page);
    const billingSessionId = await billingSessionIdPromise;
    await completeCheckout(page, apiUrl, headers, billingSessionId);

    expect(page.url()).not.toContain("checkout.stripe.com");
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    expect(page.url()).not.toContain("checkout.stripe.com");
  } finally {
    await deleteUserByEmail(email);
  }
});
