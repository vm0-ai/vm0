import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());

test("navigate to workflows page and verify heading", async ({ page }) => {
  await page.goto(`${appUrl}/workflows`);
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible({
    timeout: 20_000,
  });
});
