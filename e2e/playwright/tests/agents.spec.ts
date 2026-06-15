import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("navigate to agents page and verify heading", async ({ page }) => {
  await page.goto(`${appUrl}/agents`);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({
    timeout: 20_000,
  });
});
