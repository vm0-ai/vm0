import { expect, test, type Page } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

async function openBillingSettings(page: Page): Promise<void> {
  await page.goto(`${appUrl}/?settings=billing`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
}

test("billing settings reflects the onboarding Pro trial", async ({ page }) => {
  await openBillingSettings(page);

  await expect(page.getByText(/You are on the Pro plan/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Pro" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Upgrade to Pro" }),
  ).toHaveCount(0);
});
