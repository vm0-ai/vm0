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

  // Click the Private section's Create button
  const privateSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Private", exact: true }),
  });
  await privateSection.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Fill name and submit
  await page.getByPlaceholder("e.g. Research Assistant").fill(agentName);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create" })
    .click();

  // Verify agent appears in the list (use exact match to avoid toast collision)
  await expect(page.getByText(agentName, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
});
