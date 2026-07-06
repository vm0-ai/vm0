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
  deriveOnboardingUrl,
  startVideoOnboardingCheckout,
  waitForPaidOnboardingAppHandoff,
} from "../lib/onboarding";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import { deriveAppUrl } from "../playwright.config";

test("paid onboarding completes through the video workflow", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const apiUrl = process.env.VM0_API_URL!;
  const appUrl = deriveAppUrl(apiUrl);
  const onboardingUrl = deriveOnboardingUrl(apiUrl);
  const email = generateTestEmail();

  try {
    const userId = await createUser(email);
    const orgId = await createOrganization("E2E Paid Onboarding Org", userId);

    await clerkSetup();
    await setupClerkTestingToken({ page });
    await signInThroughHostedAuth(page, email, appUrl, {
      followRedirect: false,
      activeOrganizationId: orgId,
      mirrorStorageToUrls: [onboardingUrl],
    });

    await startVideoOnboardingCheckout(page, { apiUrl, appUrl, onboardingUrl });
    await fillStripeCheckout(page);
    await waitForPaidOnboardingAppHandoff(page, appUrl);

    expect(page.url()).not.toContain("checkout.stripe.com");
  } finally {
    await deleteUserByEmail(email);
  }
});
