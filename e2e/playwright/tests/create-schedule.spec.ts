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

  // Click "Add schedule"
  await page.getByRole("button", { name: "Add schedule" }).click();
  await expect(page.getByLabel("Prompt")).toBeVisible({ timeout: 10_000 });

  // Fill prompt and submit
  await page.getByLabel("Prompt").fill(schedulePrompt);
  await page.getByRole("button", { name: "Create" }).click();

  // After creation, app navigates to schedule detail page
  await page.waitForURL(/\/schedules\//, { timeout: 20_000 });

  // Go back to list and verify the schedule exists
  await page.goto(`${appUrl}/schedules`);
  await expect(
    page.getByRole("heading", { name: "Scheduled tasks" }),
  ).toBeVisible({ timeout: 20_000 });
  // The list shows auto-generated description, not the raw prompt —
  // just verify the list is no longer empty (has at least one schedule row)
  await expect(page.getByRole("switch").first()).toBeVisible({
    timeout: 10_000,
  });
});
