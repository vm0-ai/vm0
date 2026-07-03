import { expect, test, type Page } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

async function openBillingSettings(page: Page): Promise<void> {
  await page.goto(`${appUrl}/?settings=billing`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
}

test("billing settings reflects limited free onboarding", async ({ page }) => {
  await openBillingSettings(page);

  await expect(page.getByText(/^Limited free plan$/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("No active subscription")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upgrade" })).toBeVisible();
  await expect(page.getByText(/^Pro plan$/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Downgrade" })).toHaveCount(0);
});
