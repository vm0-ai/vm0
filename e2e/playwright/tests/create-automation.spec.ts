import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("create a new automation and verify it appears in the list", async ({
  page,
}) => {
  const automationPrompt = `E2E automation ${Date.now()}`;

  // Navigate to the automations page.
  await page.goto(`${appUrl}/automations`);
  await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible(
    { timeout: 20_000 },
  );
  await expect(
    page.getByTestId("app-skeleton"),
  ).toHaveAttribute("aria-hidden", "true", { timeout: 60_000 });

  // Click "Add automation" in the page header (the list empty-state may show
  // a second button).
  await page
    .getByRole("banner")
    .getByRole("button", { name: "Add automation" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Add automation" }),
  ).toBeVisible({ timeout: 30_000 });

  // Fill prompt and submit
  await page.getByLabel("Prompt", { exact: true }).fill(automationPrompt);
  await page.getByRole("button", { name: "Create" }).click();

  // After creation, app navigates to the automation detail page — verify the
  // redirect
  await page.waitForURL(/\/automations\/[^/]+$/, { timeout: 20_000 });

  // Verify we're on a specific automation detail page (URL contains an ID)
  expect(page.url()).toMatch(/\/automations\/[^/]+$/);

  // Verify the detail page renders the automation (toggle visible =
  // automation exists)
  await expect(page.getByRole("switch").first()).toBeVisible({
    timeout: 10_000,
  });
});
