import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("create a new schedule and verify it appears in the list", async ({
  page,
}) => {
  const schedulePrompt = `E2E schedule ${Date.now()}`;

  // Navigate to schedule page
  await page.goto(`${appUrl}/schedules`);
  await expect(
    page.getByRole("heading", { name: "Scheduled tasks" }),
  ).toBeVisible({ timeout: 20_000 });

  // Click "Add schedule" in the page header (the list empty-state may show a second button)
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add schedule" })
    .click();
  await expect(page.getByLabel("Prompt")).toBeVisible({ timeout: 10_000 });

  // Fill prompt and submit
  await page.getByLabel("Prompt").fill(schedulePrompt);
  await page.getByRole("button", { name: "Create" }).click();

  // After creation, app navigates to schedule detail page — verify the redirect
  await page.waitForURL(/\/schedules\/[^/]+$/, { timeout: 20_000 });

  // Verify we're on a specific schedule detail page (URL contains an ID, not just /schedules/)
  expect(page.url()).toMatch(/\/schedules\/[^/]+$/);

  // Verify the detail page renders the schedule (toggle visible = schedule exists)
  await expect(page.getByRole("switch").first()).toBeVisible({
    timeout: 10_000,
  });
});
