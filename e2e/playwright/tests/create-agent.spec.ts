import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());

test("create a new agent and verify it appears in the list", async ({
  page,
}) => {
  const agentName = `E2E-Agent-${Date.now()}`;

  // Navigate to agents page
  await page.goto(`${appUrl}/agents`);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({
    timeout: 20_000,
  });

  // Visibility is a segment control, so the option is a radio, not a tab.
  await page.getByRole("radio", { name: "Private", exact: true }).click();
  await page
    .getByRole("button", { name: /^(New agent|Create agent)$/ })
    .first()
    .click();
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
