import { randomUUID } from "node:crypto";

import { zeroConnectorScopeDiffContract } from "@vm0/api-contracts/contracts/zero-connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);

// Mirrors `github.ts` connector OAuth scopes; deterministic so the
// `toStrictEqual` assertions catch any silent payload drift if the
// canonical scope list changes upstream.
//
// Historical missing/stale OAuth scope rows are not built here: the public
// OAuth callback stores the currently requested scope set, so arbitrary old
// scope snapshots are not externally constructible through the API.
const GITHUB_CURRENT_SCOPES = ["repo", "project", "workflow"] as const;

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

async function connectGithub(actor: ApiTestUser): Promise<void> {
  mockGitHubConnectorOAuth();
  const start = await connectorsApi.startOauth(actor, "github", "oauth");
  await connectorsApi.completeOauthCallback("github", {
    code: `github-${randomUUID()}`,
    state: stateFromAuthorizationUrl(start.authorizationUrl),
  });
}

describe("GET /api/zero/connectors/:type/scope-diff", () => {
  it("returns 401 when not authenticated", async () => {
    const response = await connectorsApi.requestScopeDiff(
      null,
      "github",
      [401],
    );
    expectApiError(response.body);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const actor = bdd.user({ orgId: null });
    const response = await connectorsApi.requestScopeDiff(
      actor,
      "github",
      [401],
    );
    expectApiError(response.body);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for a sandbox token without connector:read capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });
    const client = setupApp({ context })(zeroConnectorScopeDiffContract);
    const response = await accept(
      client.getScopeDiff({
        params: { type: "github" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expectApiError(response.body);
    expect(response.body.error.message).toBe(
      "Missing required capability: connector:read",
    );
  });

  it("returns 404 when no connector is configured for the type", async () => {
    const actor = bdd.user();
    const response = await connectorsApi.requestScopeDiff(
      actor,
      "github",
      [404],
    );
    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("returns an empty diff when stored scopes match current scopes exactly", async () => {
    const actor = bdd.user();
    await connectGithub(actor);

    await expect(
      connectorsApi.readScopeDiff(actor, "github"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: GITHUB_CURRENT_SCOPES,
    });
  });

  it("returns an empty diff for manual auth connectors", async () => {
    const actor = bdd.user();
    await connectorsApi.connectManualGrant(actor, "openai", "api-token", {
      OPENAI_TOKEN: "sk-bdd-scope-diff",
    });

    await expect(
      connectorsApi.readScopeDiff(actor, "openai"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });
  });
});
