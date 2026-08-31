import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { signInWithClerkTestingHelper } from "../lib/auth";
import {
  createOrganization,
  createUser,
  deleteClerkTestOwnerResources,
  generateTestEmail,
} from "../lib/clerk-api";
import {
  startVideoOnboardingCheckout,
  waitForPaidOnboardingCompletion,
} from "../lib/onboarding";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import { deriveAppUrl } from "../playwright.config";

test("paid onboarding completes through the video template deep link", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const apiUrl = resolveApiBackendUrl();
  const appUrl = deriveAppUrl(apiUrl);
  const email = generateTestEmail("paid-onboarding");
  let organizationId: string | undefined;

  try {
    const userId = await createUser(email);
    organizationId = await createOrganization(
      "E2E Paid Onboarding Org",
      userId,
      "paid-onboarding",
    );

    await signInWithClerkTestingHelper(page, email, appUrl, {
      activeOrganizationId: organizationId,
      preserveAppPage: true,
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
    await deleteClerkTestOwnerResources(
      email,
      organizationId,
      "paid-onboarding",
    );
  }
});
