import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("navigate to schedule page and verify heading", async ({ page }) => {
  await page.goto(`${appUrl}/schedules`);
  // The `zeroAutomations` switch is globally on (#17307), so the schedules
  // surface renders the Automations product noun.
  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
});
