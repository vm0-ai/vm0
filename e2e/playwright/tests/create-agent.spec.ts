import type { Response } from "@playwright/test";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);

interface AgentMutationResponse {
  readonly agentId: string;
  readonly displayName: string | null;
}

interface TeamAgentResponse {
  readonly id: string;
  readonly displayName: string | null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

async function agentMutationResponse(
  response: Response,
): Promise<AgentMutationResponse> {
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("agentId" in body) ||
    typeof body.agentId !== "string" ||
    !("displayName" in body) ||
    !isNullableString(body.displayName)
  ) {
    throw new Error("Agent mutation response must contain agent identity");
  }
  return { agentId: body.agentId, displayName: body.displayName };
}

async function teamAgents(
  response: Response,
): Promise<readonly TeamAgentResponse[]> {
  const body: unknown = await response.json();
  if (!Array.isArray(body)) {
    throw new Error("Agent team response must be an array");
  }
  return body.flatMap((entry) => {
    if (
      entry &&
      typeof entry === "object" &&
      "id" in entry &&
      typeof entry.id === "string" &&
      "displayName" in entry &&
      isNullableString(entry.displayName)
    ) {
      return [{ id: entry.id, displayName: entry.displayName }];
    }
    return [];
  });
}

function isApiResponse(
  response: Response,
  method: "POST" | "PUT",
  path: string | RegExp,
): boolean {
  const url = new URL(response.url());
  return (
    response.request().method() === method &&
    (typeof path === "string" ? url.pathname === path : path.test(url.pathname))
  );
}

test("create a new agent and verify it appears in the list", async ({
  page,
}) => {
  const agentName = `E2E-Agent-${Date.now()}`;
  const teamResponses: Promise<readonly TeamAgentResponse[]>[] = [];
  const collectTeamResponse = (response: Response) => {
    const url = new URL(response.url());
    if (
      response.request().method() === "GET" &&
      url.pathname === "/api/okou/team" &&
      response.ok()
    ) {
      teamResponses.push(teamAgents(response));
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
    const createResponsePromise = page.waitForResponse((response) => {
      return isApiResponse(response, "POST", "/api/okou/agents");
    });
    const instructionsResponsePromise = page.waitForResponse((response) => {
      return isApiResponse(
        response,
        "PUT",
        /^\/api\/okou\/agents\/[^/]+\/instructions$/,
      );
    });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create" })
      .click();

    const [createResponse, instructionsResponse] = await Promise.all([
      createResponsePromise,
      instructionsResponsePromise,
    ]);
    expect(createResponse.status()).toBe(201);
    expect(instructionsResponse.status()).toBe(200);

    const [createdAgent, updatedAgent] = await Promise.all([
      agentMutationResponse(createResponse),
      agentMutationResponse(instructionsResponse),
    ]);
    expect(createdAgent.displayName).toBe(agentName);
    expect(updatedAgent).toStrictEqual(createdAgent);

    // Prove the post-create list response contains the exact created row before
    // checking the rendered list. This distinguishes persistence, response
    // shaping, and client rendering failures in remote preview diagnostics.
    await expect
      .poll(
        async () => {
          return (await Promise.all(teamResponses)).flat();
        },
        { timeout: 20_000 },
      )
      .toContainEqual({ id: createdAgent.agentId, displayName: agentName });

    // Verify agent appears in the list (use exact match to avoid toast collision)
    await expect(page.getByText(agentName, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    page.off("response", collectTeamResponse);
  }
});
