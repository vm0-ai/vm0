import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("navigate to automation page and verify heading", async ({ page }) => {
  // Deliberately enter through the legacy /schedules path: it must keep
  // redirecting to /automations (#17307), and the surface renders the
  // Automations product noun.
  await page.goto(`${appUrl}/schedules`);
  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
});
