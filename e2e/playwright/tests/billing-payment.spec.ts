import { expect, test, type Page } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

async function openBillingSettings(page: Page): Promise<void> {
  await page.goto(`${appUrl}/?settings=billing`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
}

// Since #20029, Clerk org creation bootstraps a limited-free workspace and
// the onboarding-only Pro trial checkout never runs for fresh users, so
// billing settings reflect the limited-free default instead of a Pro trial.
test("billing settings reflects the limited-free bootstrap", async ({
  page,
}) => {
  await openBillingSettings(page);

  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("No active plan")).toBeVisible();
  await expect(page.getByText("No active subscription")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Compare all plans" }),
  ).toBeVisible();
  await expect(page.getByText(/^Pro plan$/)).toHaveCount(0);
});
