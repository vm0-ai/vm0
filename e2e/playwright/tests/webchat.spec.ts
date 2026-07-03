import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("send a chat message and receive a response", async ({ page }) => {
  // Navigate to chat page (default agent)
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  // Wait for composer to be ready. Since the workflow cutover
  // (vm0-ai/vm0#19959) the composer is a tiptap contenteditable: the
  // placeholder is an overlay div, not a textarea attribute.
  await expect(page.getByText(/Ask me to automate/)).toBeVisible({
    timeout: 20_000,
  });
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 20_000 });

  // Send a message — mock claude executes this as bash
  const marker = `e2e-${Date.now()}`;
  await composer.fill(`echo ${marker}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();

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
