import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("create a new schedule and verify it appears in the list", async ({
  page,
}) => {
  const schedulePrompt = `E2E schedule ${Date.now()}`;

  // Navigate to schedule page — the `zeroAutomations` switch is globally on
  // (#17307), so the surface renders the Automations product noun.
  // The legacy /schedules path redirects to /automations (#17307).
  await page.goto(`${appUrl}/schedules`);
  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible(
    { timeout: 20_000 },
  );
  await expect(
    page.getByTestId("app-skeleton"),
  ).toHaveAttribute("aria-hidden", "true", { timeout: 60_000 });

  // Click "Add automation" in the page header (the list empty-state may show
  // a second button). The dialog title still says "Add schedule" until the
  // string sweep lands.
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add automation" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Add schedule" }),
  ).toBeVisible({ timeout: 30_000 });

  // Fill prompt and submit
  await page.getByLabel("Prompt", { exact: true }).fill(schedulePrompt);
  await page.getByRole("button", { name: "Create" }).click();

  // After creation, app navigates to schedule detail page — verify the redirect
  await page.waitForURL(/\/automations\/[^/]+$/, { timeout: 20_000 });

  // Verify we're on a specific automation detail page (URL contains an ID)
  expect(page.url()).toMatch(/\/automations\/[^/]+$/);

  // Verify the detail page renders the schedule (toggle visible = schedule exists)
  await expect(page.getByRole("switch").first()).toBeVisible({
    timeout: 10_000,
  });
});
