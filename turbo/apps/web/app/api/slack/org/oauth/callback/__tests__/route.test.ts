import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
  findTestSlackOrgInstallation,
  findTestSlackOrgConnection,
  findTestSlackOrgConnections,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { decryptSecretValue } from "../../../../../../../src/lib/crypto/secrets-encryption";
import { env } from "../../../../../../../src/env";

const context = testContext();

function mockOAuthSuccess(overrides?: {
  accessToken?: string;
  botUserId?: string;
  teamId?: string;
  teamName?: string;
  authedUserId?: string;
}) {
  const mockClient = vi.mocked(new WebClient(), true);
  mockClient.oauth.v2.access.mockResolvedValueOnce({
    ok: true,
    access_token: overrides?.accessToken ?? "xoxb-test-token",
    bot_user_id: overrides?.botUserId ?? "B123456",
    team: {
      id: overrides?.teamId ?? "T123456",
      name: overrides?.teamName ?? "Test Workspace",
    },
    authed_user: { id: overrides?.authedUserId ?? "U-installer" },
  } as never);
  return mockClient;
}

describe("/api/slack/org/oauth/callback", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should redirect to failed page when error parameter is present", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/slack/org/oauth/callback?error=access_denied",
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toBe(
      "http://localhost:3001/slack/failed?error=access_denied",
    );
  });

  it("should return 400 when code parameter is missing", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/slack/org/oauth/callback",
    );
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Missing authorization code");
  });

  it("should create installation with org_id for platform flow (first install)", async () => {
    const adminUserId = uniqueId("admin");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    mockClerk({
      userId: adminUserId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId }],
    });
    await createTestOrg(orgId);

    mockOAuthSuccess({ teamId: workspaceId, authedUserId: "U-slack-admin" });

    const state = JSON.stringify({ orgId, vm0UserId: adminUserId });
    const request = createTestRequest(
      `http://localhost:3000/api/slack/org/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    // Should redirect to /zero/works
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(
      "http://localhost:3001/zero/works",
    );

    // Verify installation was created with org_id
    const installation = await findTestSlackOrgInstallation(workspaceId);
    expect(installation).toBeDefined();
    expect(installation!.orgId).toBe(orgId);
    expect(installation!.installedByUserId).toBe(adminUserId);
    expect(installation!.botUserId).toBe("B123456");

    // Verify bot token is encrypted and decryptable
    const decrypted = decryptSecretValue(
      installation!.encryptedBotToken,
      env().SECRETS_ENCRYPTION_KEY,
    );
    expect(decrypted).toBe("xoxb-test-token");

    // Verify connection was created
    const connection = await findTestSlackOrgConnection(
      "U-slack-admin",
      workspaceId,
    );
    expect(connection).toBeDefined();
    expect(connection!.vm0UserId).toBe(adminUserId);
    expect(connection!.orgId).toBe(orgId);
  });

  it("should reject org member who is not an admin", async () => {
    const userId = uniqueId("member");
    const orgId = uniqueId("org");

    // User is a member of this org but with "member" role, not "admin"
    mockClerk({
      userId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId, role: "org:member" }],
    });
    await createTestOrg(orgId);

    mockOAuthSuccess();

    const state = JSON.stringify({ orgId, vm0UserId: userId });
    const request = createTestRequest(
      `http://localhost:3000/api/slack/org/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    // Non-admin member should be redirected to failed page
    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("/slack/failed");
    expect(location).toContain("Only%20org%20admins");
  });

  it("should throw when user is not an org member", async () => {
    const userId = uniqueId("outsider");
    const orgId = uniqueId("org");

    // User is not a member of this org (no clerkOrgs match)
    mockClerk({ userId });

    mockOAuthSuccess();

    const state = JSON.stringify({ orgId, vm0UserId: userId });
    const request = createTestRequest(
      `http://localhost:3000/api/slack/org/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    );

    // requireOrgMember throws ForbiddenError — let it propagate to framework
    await expect(GET(request)).rejects.toThrow(
      "You are not a member of this organization",
    );
  });

  it("should create installation with null org_id for slack-initiated flow", async () => {
    const workspaceId = uniqueId("ws");
    mockOAuthSuccess({
      teamId: workspaceId,
      teamName: "Slack Workspace",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/slack/org/oauth/callback?code=valid-code",
    );
    const response = await GET(request);

    // Should redirect to installed page
    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("/slack/installed");
    expect(location).toContain("workspace=Slack%20Workspace");

    // Verify installation was created with null org_id
    const installation = await findTestSlackOrgInstallation(workspaceId);
    expect(installation).toBeDefined();
    expect(installation!.orgId).toBeNull();
    expect(installation!.installedByUserId).toBeNull();
  });

  it("should update bot token on re-install and preserve org binding", async () => {
    const adminUserId = uniqueId("admin");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    mockClerk({
      userId: adminUserId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId }],
    });
    await createTestOrg(orgId);

    // First install (platform flow)
    mockOAuthSuccess({
      teamId: workspaceId,
      accessToken: "xoxb-original-token",
      botUserId: "B-original",
      authedUserId: "U-original",
    });

    const state = JSON.stringify({ orgId, vm0UserId: adminUserId });
    const firstRequest = createTestRequest(
      `http://localhost:3000/api/slack/org/oauth/callback?code=first-code&state=${encodeURIComponent(state)}`,
    );
    await GET(firstRequest);

    // Re-install (slack-initiated, no state)
    mockOAuthSuccess({
      teamId: workspaceId,
      accessToken: "xoxb-new-token",
      botUserId: "B-new",
      teamName: "Renamed Workspace",
      authedUserId: "U-different",
    });

    const secondRequest = createTestRequest(
      `http://localhost:3000/api/slack/org/oauth/callback?code=second-code`,
    );
    const response = await GET(secondRequest);

    // Re-install without state redirects to installed page
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain("/slack/installed");

    // Verify bot token updated, org binding preserved
    const installation = await findTestSlackOrgInstallation(workspaceId);
    expect(installation).toBeDefined();
    expect(installation!.orgId).toBe(orgId);
    expect(installation!.installedByUserId).toBe(adminUserId);
    expect(installation!.botUserId).toBe("B-new");
    expect(installation!.slackWorkspaceName).toBe("Renamed Workspace");

    // Verify new token is encrypted correctly
    const decrypted = decryptSecretValue(
      installation!.encryptedBotToken,
      env().SECRETS_ENCRYPTION_KEY,
    );
    expect(decrypted).toBe("xoxb-new-token");
  });

  it("should redirect to failed page when OAuth exchange fails", async () => {
    const mockClient = vi.mocked(new WebClient(), true);
    mockClient.oauth.v2.access.mockResolvedValueOnce({
      ok: false,
      error: "invalid_code",
    } as never);

    const request = createTestRequest(
      "http://localhost:3000/api/slack/org/oauth/callback?code=expired-code",
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("/slack/failed");
    expect(location).toContain("error=");
  });

  it("should create connection idempotently on duplicate platform flow", async () => {
    const adminUserId = uniqueId("admin");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    mockClerk({
      userId: adminUserId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId }],
    });
    await createTestOrg(orgId);

    // First install
    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-slack-admin",
    });

    const state = JSON.stringify({ orgId, vm0UserId: adminUserId });
    const firstRequest = createTestRequest(
      `http://localhost:3000/api/slack/org/oauth/callback?code=first-code&state=${encodeURIComponent(state)}`,
    );
    await GET(firstRequest);

    // Second install with same state (re-install with platform flow)
    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-slack-admin",
    });

    const secondRequest = createTestRequest(
      `http://localhost:3000/api/slack/org/oauth/callback?code=second-code&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(secondRequest);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(
      "http://localhost:3001/zero/works",
    );

    // Should still have exactly one connection (onConflictDoNothing)
    const connections = await findTestSlackOrgConnections(
      "U-slack-admin",
      workspaceId,
    );
    expect(connections).toHaveLength(1);
  });
});
