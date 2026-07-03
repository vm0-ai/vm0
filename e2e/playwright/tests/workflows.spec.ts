import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

// Replaces the legacy automations-page specs: the automation -> workflow
// cutover (vm0-ai/vm0#19959) froze the legacy surface and made workflows the
// scheduling entry point for everyone.
test("navigate to workflows page and verify heading", async ({ page }) => {
  await page.goto(`${appUrl}/workflows`);
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible({
    timeout: 20_000,
  });
});
