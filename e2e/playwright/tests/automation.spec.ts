import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("navigate to automation page and verify heading", async ({ page }) => {
  await page.goto(`${appUrl}/automations`);
  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
});
