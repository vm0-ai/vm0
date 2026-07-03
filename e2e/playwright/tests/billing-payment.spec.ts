import { expect, test, type Page } from "@playwright/test";
import { authHeadersForToken } from "../lib/onboarding";
import { deriveAppUrl } from "../playwright.config";

const apiUrl = process.env.VM0_API_URL!;
const appUrl = deriveAppUrl(apiUrl);

async function openBillingSettings(page: Page): Promise<void> {
  await page.goto(`${appUrl}/?settings=billing`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
}

test("billing settings reflects limited free onboarding", async ({ page }) => {
  await openBillingSettings(page);

  await expectLimitedFreeBillingStatus(page);
  await expect(page.getByText(/^No active plan$/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("No active subscription")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade" })).toBeVisible();
  await expect(page.getByText(/^Pro plan$/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Downgrade" })).toHaveCount(0);
});

async function expectLimitedFreeBillingStatus(page: Page): Promise<void> {
  const token = await currentClerkSessionToken(page);
  const response = await page.request.get(`${apiUrl}/api/zero/billing/status`, {
    headers: authHeadersForToken(token),
  });
  if (response.status() !== 200) {
    throw new Error(
      `billing status failed with ${response.status()}: ${await response.text()}`,
    );
  }

  const body: unknown = await response.json();
  if (!hasBillingTier(body)) {
    throw new Error(
      `Unexpected billing status response: ${JSON.stringify(body)}`,
    );
  }
  expect(body.tier).toBe("limited-free-1");
}

async function currentClerkSessionToken(page: Page): Promise<string> {
  await page.waitForFunction(() => Boolean(window.Clerk?.session), undefined, {
    timeout: 30_000,
  });
  const token = await page.evaluate(async () => {
    return (await window.Clerk?.session?.getToken({ skipCache: true })) ?? null;
  });
  if (!token) {
    throw new Error("Clerk session token unavailable");
  }
  return token;
}

function hasBillingTier(value: unknown): value is { readonly tier: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "tier" in value &&
    typeof value.tier === "string"
  );
}
