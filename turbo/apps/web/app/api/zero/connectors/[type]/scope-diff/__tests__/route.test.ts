import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { generateSandboxToken } from "../../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

const GITHUB_CURRENT_SCOPES = ["repo", "project", "workflow"] as const;

async function setupOrg(userId: string) {
  const slug = uniqueId("zscope");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function scopeDiffUrl(type: string): string {
  return `http://localhost:3000/api/zero/connectors/${type}/scope-diff`;
}

describe("GET /api/zero/connectors/:type/scope-diff", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await GET(createTestRequest(scopeDiffUrl("github")));

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mockClerk({ userId: uniqueId("zscope-no-org"), orgId: null });

    const response = await GET(createTestRequest(scopeDiffUrl("github")));

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for a sandbox token without connector:read capability", async () => {
    const token = await generateSandboxToken(
      uniqueId("zscope-sandbox-user"),
      "run-1",
      "org-test",
    );

    const response = await GET(
      createTestRequest(scopeDiffUrl("github"), {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.message).toBe(
      "Missing required capability: connector:read",
    );
  });

  it("returns 404 when no connector is configured for the type", async () => {
    const userId = uniqueId("zscope-nf");
    await setupOrg(userId);

    const response = await GET(createTestRequest(scopeDiffUrl("github")));

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("returns an empty diff when stored scopes match current scopes exactly", async () => {
    const userId = uniqueId("zscope-exact");
    const { orgId } = await setupOrg(userId);
    await context.createConnector(orgId, {
      userId,
      type: "github",
      oauthScopes: GITHUB_CURRENT_SCOPES,
    });

    const response = await GET(createTestRequest(scopeDiffUrl("github")));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: GITHUB_CURRENT_SCOPES,
    });
  });

  it("returns added scopes when the connector is missing required scopes", async () => {
    const userId = uniqueId("zscope-added");
    const { orgId } = await setupOrg(userId);
    await context.createConnector(orgId, {
      userId,
      type: "github",
      oauthScopes: ["repo"],
    });

    const response = await GET(createTestRequest(scopeDiffUrl("github")));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toStrictEqual({
      addedScopes: ["project", "workflow"],
      removedScopes: [],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes: ["repo"],
    });
  });

  it("returns removed scopes when the connector has stale extra scopes", async () => {
    const userId = uniqueId("zscope-removed");
    const { orgId } = await setupOrg(userId);
    const storedScopes = [...GITHUB_CURRENT_SCOPES, "delete_repo"];
    await context.createConnector(orgId, {
      userId,
      type: "github",
      oauthScopes: storedScopes,
    });

    const response = await GET(createTestRequest(scopeDiffUrl("github")));

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toStrictEqual({
      addedScopes: [],
      removedScopes: ["delete_repo"],
      currentScopes: GITHUB_CURRENT_SCOPES,
      storedScopes,
    });
  });
});
