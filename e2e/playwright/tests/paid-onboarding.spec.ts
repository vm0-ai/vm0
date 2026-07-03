import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { refreshClerkSessionToken, signInThroughHostedAuth } from "../lib/auth";
import {
  createOrganization,
  createUser,
  deleteUserByEmail,
  generateTestEmail,
} from "../lib/clerk-api";
import { routeOnboardingApiToPreview } from "../lib/onboarding";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import {
  deriveAppUrl,
  deriveOnboardingUrl,
  deriveServiceOrigin,
} from "../playwright.config";

test("paid onboarding completes through the video workflow", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const apiUrl = process.env.VM0_API_URL!;
  const appUrl = deriveAppUrl(apiUrl);
  const onboardingUrl = deriveOnboardingUrl(apiUrl);
  const onboardingAuthAppUrl = deriveServiceOrigin(onboardingUrl, "app");
  const onboardingApiUrl = deriveServiceOrigin(onboardingUrl, "api");
  const email = generateTestEmail();

  try {
    const userId = await createUser(email);
    const orgId = await createOrganization("E2E Paid Onboarding Org", userId);

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

    await page.goto(onboardingUrl, {
      waitUntil: "domcontentloaded",
    });
    await refreshClerkSessionToken(page, { activeOrganizationId: orgId });

    const videoChoice = page.getByRole("radio", {
      name: /Video production/i,
    });
    await expect(videoChoice).toBeVisible({ timeout: 60_000 });
    await videoChoice.click();

    const continueButton = page.getByTestId("onboarding-next-button");
    await expect(continueButton).toBeEnabled({ timeout: 60_000 });
    await continueButton.click();

    await expect(
      page.getByRole("heading", {
        name: /Pick a video template to start from/i,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(continueButton).toBeEnabled({ timeout: 60_000 });
    await continueButton.click();

    await expect(
      page.getByRole("heading", { name: /Customize your video/i }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(continueButton).toHaveText(/Upgrade Pro to run/i, {
      timeout: 30_000,
    });
    await expect(continueButton).toBeEnabled({ timeout: 60_000 });

    const checkoutResponse = page.waitForResponse(
      (response) => {
        return (
          response.url().includes("/api/zero/billing/checkout") &&
          response.request().method() === "POST"
        );
      },
      { timeout: 60_000 },
    );
    await continueButton.click();

    const response = await checkoutResponse;
    if (response.status() !== 200) {
      throw new Error(`video checkout failed with ${response.status()}`);
    }

    const checkoutCompletionResponse = page.waitForResponse(
      (completion) => {
        return (
          completion.url().includes("/api/zero/billing/checkout/complete") &&
          completion.request().method() === "POST"
        );
      },
      { timeout: 120_000 },
    );

    await fillStripeCheckout(page);
    const completionResponse = await checkoutCompletionResponse;
    if (completionResponse.status() !== 200) {
      throw new Error(
        `checkout completion failed with ${completionResponse.status()}`,
      );
    }
    expect(page.url()).not.toContain("checkout.stripe.com");
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    expect(page.url()).not.toContain("checkout.stripe.com");
  } finally {
    await deleteUserByEmail(email);
  }
});
