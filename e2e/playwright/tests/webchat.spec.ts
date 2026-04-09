import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("send a chat message and receive a response", async ({ page }) => {
  // Navigate to chat page (default agent)
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  // Wait for composer to be ready
  const textarea = page.getByPlaceholder(/Ask me to automate/);
  await expect(textarea).toBeVisible({ timeout: 20_000 });

  // Send a message — mock claude executes this as bash
  const marker = `e2e-${Date.now()}`;
  await textarea.fill(`echo ${marker}`);
  await page.getByRole("button", { name: "Send" }).click();

  // Verify user message appears
  await expect(
    page.locator('[data-role="user"]').last().getByText(marker),
  ).toBeVisible({ timeout: 10_000 });

  // Wait for assistant response — 120s because the full pipeline runs:
  // runner picks up job → starts VM sandbox → mock claude executes → response streams back.
  // Requires USE_MOCK_CLAUDE=true in CI. Expected latency: 60–90s.
  await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({
    timeout: 120_000,
  });
});
