import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL ?? "");

let agentName: string;

test.describe.serial("team page agent CRUD", () => {
  test.beforeAll(() => {
    agentName = `E2E-Agent-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  });

  test("navigate to team page and verify default agent", async ({ page }) => {
    await page.goto(`${appUrl}/agents`);
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByRole("heading", { name: "Your core agent" })
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByRole("button", { name: "New agent" })
    ).toBeVisible();
  });

  test("create new agent via dialog", async ({ page }) => {
    await page.goto(`${appUrl}/agents`);
    await page.getByRole("button", { name: "New agent" }).click();
    await expect(
      page.getByRole("heading", { name: "Create a new agent" })
    ).toBeVisible({
      timeout: 10_000,
    });
    await page.getByPlaceholder("e.g. Research Assistant").fill(agentName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText(agentName)).toBeVisible({ timeout: 20_000 });
  });

  test("verify new agent appears on team page", async ({ page }) => {
    await page.goto(`${appUrl}/agents`);
    await expect(page.getByText(agentName)).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/agents/);
  });
});
