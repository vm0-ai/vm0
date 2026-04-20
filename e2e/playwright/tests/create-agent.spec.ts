import { expect, test } from "@playwright/test";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_URL!);

test("create a new agent and verify it appears in the list", async ({
  page,
}) => {
  const agentName = `E2E-Agent-${Date.now()}`;

  // Navigate to agents page
  await page.goto(`${appUrl}/agents`);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({
    timeout: 20_000,
  });

  // Click "New agent"
  await page.getByRole("button", { name: "New agent" }).click();
  await expect(
    page.getByRole("heading", { name: "Create a new agent" }),
  ).toBeVisible();

  // Fill name and submit
  await page.getByPlaceholder("e.g. Research Assistant").fill(agentName);
  await page.getByRole("button", { name: "Create" }).click();

  // Verify agent appears in the list (use exact match to avoid toast collision)
  await expect(page.getByText(agentName, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
});
