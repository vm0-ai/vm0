import { expect, test } from "../fixtures";
import { signInThroughHostedAuth } from "../lib/auth";
import {
  createOrganization,
  createUser,
  deleteUserByEmail,
  generateTestEmail,
} from "../lib/clerk-api";
import {
  startVideoOnboardingCheckout,
  waitForPaidOnboardingCompletion,
} from "../lib/onboarding";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import { deriveAppUrl } from "../playwright.config";

test("paid onboarding completes through the video workflow", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const apiUrl = process.env.VM0_API_BACKEND_URL!;
  const appUrl = deriveAppUrl(apiUrl);
  const email = generateTestEmail();

  try {
    const userId = await createUser(email);
    const orgId = await createOrganization("E2E Paid Onboarding Org", userId);

    await signInThroughHostedAuth(page, email, appUrl, {
      followRedirect: false,
      activeOrganizationId: orgId,
    });

    await startVideoOnboardingCheckout(page, { appUrl });
    await fillStripeCheckout(page);
    const completionUrl = await waitForPaidOnboardingCompletion(page, {
      appUrl,
    });

    expect(completionUrl.pathname).toMatch(
      /^\/(?:prompt|agents\/[^/]+\/chat|chats\/[^/]+)$/,
    );
  } finally {
    await deleteUserByEmail(email);
  }
});
