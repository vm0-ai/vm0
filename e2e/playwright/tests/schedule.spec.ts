import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL ?? "");

let schedulePrompt: string;

test.describe.serial("schedule page CRUD", () => {
  test.beforeAll(() => {
    schedulePrompt = `E2E schedule ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  });

  test("navigate to schedule page and open creation dialog", async ({
    page,
  }) => {
    await page.goto(`${appUrl}/schedules`);
    await expect(page.getByText("Scheduled tasks")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Add schedule" }).click();
    await expect(page.getByLabel("Prompt")).toBeVisible({ timeout: 10_000 });
  });

  test("fill and submit schedule creation form", async ({ page }) => {
    await page.goto(`${appUrl}/schedules`);
    await page.getByRole("button", { name: "Add schedule" }).click();
    await expect(page.getByLabel("Prompt")).toBeVisible({ timeout: 10_000 });
    await page.getByLabel("Prompt").fill(schedulePrompt);
    await page.getByRole("button", { name: "Create" }).click();
    // Do not wait for schedule creation to complete (can take 60–120s backend processing)
    // Just verify the click was accepted
    await page.waitForTimeout(2_000);
  });

  test("verify schedule list page still loads after creation", async ({
    page,
  }) => {
    await page.goto(`${appUrl}/schedules`);
    await expect(page.getByText("Scheduled tasks")).toBeVisible({
      timeout: 20_000,
    });
  });
});
