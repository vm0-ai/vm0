import type { Response } from "@playwright/test";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);

async function teamDisplayNames(
  response: Response,
): Promise<readonly string[]> {
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("Agent team response must be an array");
  }
  return body.flatMap((entry) => {
    if (
      entry &&
      typeof entry === "object" &&
      "displayName" in entry &&
      typeof entry.displayName === "string"
    ) {
      return [entry.displayName];
    }
    return [];
  });
}

test("create a new agent and verify it appears in the list", async ({
  page,
}) => {
  const agentName = `E2E-Agent-${Date.now()}`;
  const teamResponses: Promise<readonly string[]>[] = [];
  const collectTeamResponse = (response: Response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === "GET" &&
      url.pathname === "/api/okou/team" &&
      response.ok()
    ) {
      teamResponses.push(teamDisplayNames(response));
    }
  };
  page.on("response", collectTeamResponse);

  try {
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

    // Prove the post-create list response contains the agent before checking
    // the rendered list. This keeps API persistence failures distinguishable
    // from client rendering failures in remote preview diagnostics.
    await expect
      .poll(
        async () => {
          return (await Promise.all(teamResponses)).flat();
        },
        { timeout: 20_000 },
      )
      .toContain(agentName);

    // Verify agent appears in the list (use exact match to avoid toast collision)
    await expect(page.getByText(agentName, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    page.off("response", collectTeamResponse);
  }
});
