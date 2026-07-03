import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "@playwright/test";
import { signInThroughHostedAuth } from "../lib/auth";
import {
  createOrganization,
  createUser,
  deleteUserByEmail,
  generateTestEmail,
} from "../lib/clerk-api";
import { fillStripeCheckout } from "../lib/stripe-checkout";
import { deriveAppUrl } from "../playwright.config";

function deriveWwwUrl(sourceUrl: string): string {
  return sourceUrl
    .replace(/-app\./, "-www.")
    .replace(/\/\/app\./, "//www.")
    .replace(/-api\./, "-www.")
    .replace(/\/\/api\./, "//www.");
}

test("paid onboarding completes through the video workflow", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const appUrl = deriveAppUrl(process.env.VM0_API_URL!);
  const email = generateTestEmail();

  try {
    const userId = await createUser(email);
    await createOrganization("E2E Paid Onboarding Org", userId);

    await clerkSetup();
    await setupClerkTestingToken({ page });
    await signInThroughHostedAuth(page, email, appUrl);

    await page.goto(`${deriveWwwUrl(appUrl)}/onboarding/491858`, {
      waitUntil: "domcontentloaded",
    });

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
      throw new Error(
        `video checkout failed with ${response.status()}: ${await response.text()}`,
      );
    }

    await fillStripeCheckout(page);
    await page.waitForURL(
      (url) => {
        return url.origin === new URL(appUrl).origin;
      },
      { timeout: 120_000 },
    );
    expect(page.url()).not.toContain("checkout.stripe.com");
  } finally {
    await deleteUserByEmail(email);
  }
});
