import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("navigate to schedule page and verify heading", async ({ page }) => {
  await page.goto(`${appUrl}/schedules`);
  await expect(
    page.getByRole("heading", { name: "Scheduled tasks" }),
  ).toBeVisible({
    timeout: 20_000,
  });
});
