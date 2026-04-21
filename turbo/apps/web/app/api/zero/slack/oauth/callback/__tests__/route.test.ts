import { describe, it, expect, vi, beforeEach } from "vitest";
import { WebClient } from "@slack/web-api";
import { GET } from "../route";
import {
  createTestRequest,
  createTestOrg,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  findTestSlackOrgInstallation,
  findTestSlackOrgConnection,
  findTestSlackOrgConnections,
} from "../../../../../../../src/__tests__/db-test-assertions/slack";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { decryptSecretValue } from "../../../../../../../src/lib/shared/crypto/secrets-encryption";
import { env } from "../../../../../../../src/env";

const context = testContext();

function mockOAuthSuccess(overrides?: {
  accessToken?: string;
  botUserId?: string;
  teamId?: string;
  teamName?: string;
  authedUserId?: string;
  scope?: string;
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
    scope: overrides?.scope ?? undefined,
  } as never);
  return mockClient;
}

describe("/api/zero/slack/oauth/callback", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should redirect to failed page when error parameter is present", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/callback?error=access_denied",
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
      "http://localhost:3000/api/zero/slack/oauth/callback",
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
      `http://localhost:3000/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    // Should redirect to /slack/connect?status=connected
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain(
      "/settings/slack?status=connected",
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
    expect(connection!.slackWorkspaceId).toBe(workspaceId);
  });

  it("should reject org member who is not an admin", async () => {
    const userId = uniqueId("member");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    // User is a member of this org but with "member" role, not "admin"
    mockClerk({
      userId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId, role: "org:member" }],
    });
    await createTestOrg(orgId);

    mockOAuthSuccess({ teamId: workspaceId });

    const state = JSON.stringify({ orgId, vm0UserId: userId });
    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
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
    const workspaceId = uniqueId("ws");

    // User is not a member of this org (no clerkOrgs match)
    mockClerk({ userId });

    mockOAuthSuccess({ teamId: workspaceId });

    const state = JSON.stringify({ orgId, vm0UserId: userId });
    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
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
      authedUserId: "U-slack-installer",
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/slack/oauth/callback?code=valid-code",
    );
    const response = await GET(request);

    // Should redirect to /settings/slack with w+u so the user can claim
    // the orphan installation via the connect flow after sign-in.
    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("/settings/slack");
    expect(location).toContain(`w=${workspaceId}`);
    expect(location).toContain("u=U-slack-installer");

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
      `http://localhost:3000/api/zero/slack/oauth/callback?code=first-code&state=${encodeURIComponent(state)}`,
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
      `http://localhost:3000/api/zero/slack/oauth/callback?code=second-code`,
    );
    const response = await GET(secondRequest);

    // Re-install without state redirects to /settings/slack with w+u context.
    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("/settings/slack");
    expect(location).toContain(`w=${workspaceId}`);
    expect(location).toContain("u=U-different");

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
      "http://localhost:3000/api/zero/slack/oauth/callback?code=expired-code",
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("/slack/failed");
    expect(location).toContain("error=");
  });

  it("should reject install when workspace is already bound to a different org", async () => {
    const orgAAdmin = uniqueId("admin-a");
    const orgA = uniqueId("org-a");
    const orgBAdmin = uniqueId("admin-b");
    const orgB = uniqueId("org-b");
    const workspaceId = uniqueId("ws");

    // First: Org A installs successfully
    mockClerk({
      userId: orgAAdmin,
      clerkOrgs: [{ id: orgA, slug: orgA, name: orgA }],
    });
    await createTestOrg(orgA);

    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-admin-a",
    });

    const stateA = JSON.stringify({ orgId: orgA, vm0UserId: orgAAdmin });
    const requestA = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=code-a&state=${encodeURIComponent(stateA)}`,
    );
    const responseA = await GET(requestA);
    expect(responseA.status).toBe(307);
    expect(responseA.headers.get("Location")).toContain(
      "/settings/slack?status=connected",
    );

    // Second: Org B tries to install the same workspace
    mockClerk({
      userId: orgBAdmin,
      clerkOrgs: [{ id: orgB, slug: orgB, name: orgB }],
    });
    await createTestOrg(orgB);

    mockOAuthSuccess({
      teamId: workspaceId,
      accessToken: "xoxb-org-b-token",
      authedUserId: "U-admin-b",
    });

    const stateB = JSON.stringify({ orgId: orgB, vm0UserId: orgBAdmin });
    const requestB = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=code-b&state=${encodeURIComponent(stateB)}`,
    );
    const responseB = await GET(requestB);

    // Should redirect to /works with error
    expect(responseB.status).toBe(307);
    const location = responseB.headers.get("Location")!;
    expect(location).toContain("/settings/slack?error=");
    expect(decodeURIComponent(location)).toContain(
      "already installed by another organization",
    );

    // Verify org A's installation is untouched
    const installation = await findTestSlackOrgInstallation(workspaceId);
    expect(installation!.orgId).toBe(orgA);

    // Verify bot token was NOT overwritten
    const decrypted = decryptSecretValue(
      installation!.encryptedBotToken,
      env().SECRETS_ENCRYPTION_KEY,
    );
    expect(decrypted).toBe("xoxb-test-token");

    // Verify no connection was created for org B
    const connectionB = await findTestSlackOrgConnection(
      "U-admin-b",
      workspaceId,
    );
    expect(connectionB).toBeUndefined();
  });

  it("should allow re-install by same org (no rejection)", async () => {
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
      accessToken: "xoxb-original",
      authedUserId: "U-admin",
    });

    const state = JSON.stringify({ orgId, vm0UserId: adminUserId });
    const firstRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=first&state=${encodeURIComponent(state)}`,
    );
    await GET(firstRequest);

    // Same org re-installs
    mockOAuthSuccess({
      teamId: workspaceId,
      accessToken: "xoxb-refreshed",
      authedUserId: "U-admin",
    });

    const secondRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=second&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(secondRequest);

    // Should succeed
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain(
      "/settings/slack?status=connected",
    );

    // Bot token should be updated
    const installation = await findTestSlackOrgInstallation(workspaceId);
    const decrypted = decryptSecretValue(
      installation!.encryptedBotToken,
      env().SECRETS_ENCRYPTION_KEY,
    );
    expect(decrypted).toBe("xoxb-refreshed");
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
      `http://localhost:3000/api/zero/slack/oauth/callback?code=first-code&state=${encodeURIComponent(state)}`,
    );
    await GET(firstRequest);

    // Second install with same state (re-install with platform flow)
    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-slack-admin",
    });

    const secondRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=second-code&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(secondRequest);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain(
      "/settings/slack?status=connected",
    );

    // Should still have exactly one connection (onConflictDoNothing)
    const connections = await findTestSlackOrgConnections(
      "U-slack-admin",
      workspaceId,
    );
    expect(connections).toHaveLength(1);
  });

  it("should persist botScopes on first install", async () => {
    const adminUserId = uniqueId("admin");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    mockClerk({
      userId: adminUserId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId }],
    });
    await createTestOrg(orgId);

    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-slack-admin",
      scope: "chat:write,channels:read,users:read",
    });

    const state = JSON.stringify({ orgId, vm0UserId: adminUserId });
    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    );
    await GET(request);

    const installation = await findTestSlackOrgInstallation(workspaceId);
    expect(installation).toBeDefined();
    expect(installation!.botScopes).toBe(
      JSON.stringify(["chat:write", "channels:read", "users:read"]),
    );
  });

  it("should persist botScopes on re-install", async () => {
    const adminUserId = uniqueId("admin");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    mockClerk({
      userId: adminUserId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId }],
    });
    await createTestOrg(orgId);

    // First install with partial scopes
    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-slack-admin",
      scope: "chat:write",
    });

    const state = JSON.stringify({ orgId, vm0UserId: adminUserId });
    const firstRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=first-code&state=${encodeURIComponent(state)}`,
    );
    await GET(firstRequest);

    // Re-install with expanded scopes
    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-slack-admin",
      scope: "chat:write,channels:read,users:read",
    });

    const reinstateState = JSON.stringify({
      orgId,
      vm0UserId: adminUserId,
      reinstall: true,
    });
    const secondRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=second-code&state=${encodeURIComponent(reinstateState)}`,
    );
    await GET(secondRequest);

    const installation = await findTestSlackOrgInstallation(workspaceId);
    expect(installation).toBeDefined();
    expect(installation!.botScopes).toBe(
      JSON.stringify(["chat:write", "channels:read", "users:read"]),
    );
  });

  it("should forward prompt from state to notifyConnectSuccess DM", async () => {
    const adminUserId = uniqueId("admin");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    mockClerk({
      userId: adminUserId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId }],
    });
    await createTestOrg(orgId);

    mockOAuthSuccess({ teamId: workspaceId, authedUserId: "U-prompt-admin" });

    const state = JSON.stringify({
      orgId,
      vm0UserId: adminUserId,
      prompt: "summarize my inbox",
    });
    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain(
      "/settings/slack?status=connected",
    );

    // Allow fire-and-forget notifyConnectSuccess to complete
    await vi.waitFor(async () => {
      const mockClient = vi.mocked(new WebClient(), true);
      const postMessageFn = mockClient.chat.postMessage as ReturnType<
        typeof vi.fn
      >;
      const promptCall = postMessageFn.mock.calls.find((call: unknown[]) => {
        return (
          typeof call[0] === "object" &&
          call[0] !== null &&
          "text" in call[0] &&
          typeof (call[0] as { text: string }).text === "string" &&
          (call[0] as { text: string }).text.includes("summarize my inbox")
        );
      });
      expect(promptCall).toBeDefined();
    });
  });

  it("should not send prompt DM when state has no prompt", async () => {
    const adminUserId = uniqueId("admin");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    mockClerk({
      userId: adminUserId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId }],
    });
    await createTestOrg(orgId);

    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-noprompt-admin",
    });

    const state = JSON.stringify({ orgId, vm0UserId: adminUserId });
    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=valid-code&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain(
      "/settings/slack?status=connected",
    );

    // Allow fire-and-forget notifyConnectSuccess to complete
    await vi.waitFor(async () => {
      const mockClient = vi.mocked(new WebClient(), true);
      const postMessageFn = mockClient.chat.postMessage as ReturnType<
        typeof vi.fn
      >;
      // Verify no "would you like me to run" prompt DM was sent
      const promptCall = postMessageFn.mock.calls.find((call: unknown[]) => {
        return (
          typeof call[0] === "object" &&
          call[0] !== null &&
          "text" in call[0] &&
          typeof (call[0] as { text: string }).text === "string" &&
          (call[0] as { text: string }).text.includes(
            "would you like me to run",
          )
        );
      });
      expect(promptCall).toBeUndefined();
    });
  });

  it("should forward prompt from connect flow state to notifyConnectSuccess", async () => {
    const adminUserId = uniqueId("admin");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    mockClerk({
      userId: adminUserId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId }],
    });
    await createTestOrg(orgId);

    // First, create an installation via the install flow
    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-connect-admin",
    });
    const installState = JSON.stringify({ orgId, vm0UserId: adminUserId });
    const installRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=install-code&state=${encodeURIComponent(installState)}`,
    );
    await GET(installRequest);

    // Now use the connect flow with a prompt
    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-connect-admin",
    });
    const connectState = JSON.stringify({
      orgId,
      vm0UserId: adminUserId,
      flow: "connect",
      prompt: "summarize my inbox",
    });
    const connectRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=connect-code&state=${encodeURIComponent(connectState)}`,
    );
    const response = await GET(connectRequest);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain(
      "/settings/slack?status=connected",
    );

    // Allow fire-and-forget notifyConnectSuccess to complete
    await vi.waitFor(async () => {
      const mockClient = vi.mocked(new WebClient(), true);
      const postMessageFn = mockClient.chat.postMessage as ReturnType<
        typeof vi.fn
      >;
      const promptCall = postMessageFn.mock.calls.find((call: unknown[]) => {
        return (
          typeof call[0] === "object" &&
          call[0] !== null &&
          "text" in call[0] &&
          typeof (call[0] as { text: string }).text === "string" &&
          (call[0] as { text: string }).text.includes("summarize my inbox")
        );
      });
      expect(promptCall).toBeDefined();
    });
  });

  it("should not send prompt DM in connect flow when state has no prompt", async () => {
    const adminUserId = uniqueId("admin");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    mockClerk({
      userId: adminUserId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId }],
    });
    await createTestOrg(orgId);

    // Create installation
    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-noprompt-connect",
    });
    const installState = JSON.stringify({ orgId, vm0UserId: adminUserId });
    const installRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=install-code&state=${encodeURIComponent(installState)}`,
    );
    await GET(installRequest);

    // Connect flow without prompt
    mockOAuthSuccess({
      teamId: workspaceId,
      authedUserId: "U-noprompt-connect",
    });
    const connectState = JSON.stringify({
      orgId,
      vm0UserId: adminUserId,
      flow: "connect",
    });
    const connectRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=connect-code&state=${encodeURIComponent(connectState)}`,
    );
    const response = await GET(connectRequest);

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toContain(
      "/settings/slack?status=connected",
    );

    // Allow fire-and-forget notifyConnectSuccess to complete
    await vi.waitFor(async () => {
      const mockClient = vi.mocked(new WebClient(), true);
      const postMessageFn = mockClient.chat.postMessage as ReturnType<
        typeof vi.fn
      >;
      const promptCall = postMessageFn.mock.calls.find((call: unknown[]) => {
        return (
          typeof call[0] === "object" &&
          call[0] !== null &&
          "text" in call[0] &&
          typeof (call[0] as { text: string }).text === "string" &&
          (call[0] as { text: string }).text.includes(
            "would you like me to run",
          )
        );
      });
      expect(promptCall).toBeUndefined();
    });
  });

  it("should redirect connect flow errors to /settings/slack", async () => {
    const state = JSON.stringify({
      flow: "connect",
    });
    const request = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=some-code&state=${encodeURIComponent(state)}`,
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location")!;
    expect(location).toContain("/settings/slack?error=");
  });

  it("should redirect to /?tab=works&updated=1 when reinstall flag is set", async () => {
    const adminUserId = uniqueId("admin");
    const orgId = uniqueId("org");
    const workspaceId = uniqueId("ws");

    mockClerk({
      userId: adminUserId,
      clerkOrgs: [{ id: orgId, slug: orgId, name: orgId }],
    });
    await createTestOrg(orgId);

    // First install to create an existing record (makes isReinstall=true)
    mockOAuthSuccess({ teamId: workspaceId, authedUserId: "U-admin" });
    const state = JSON.stringify({ orgId, vm0UserId: adminUserId });
    const firstRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=first-code&state=${encodeURIComponent(state)}`,
    );
    await GET(firstRequest);

    // Re-install with reinstall flag in state
    mockOAuthSuccess({ teamId: workspaceId, authedUserId: "U-admin" });
    const reinstallState = JSON.stringify({
      orgId,
      vm0UserId: adminUserId,
      reinstall: true,
    });
    const secondRequest = createTestRequest(
      `http://localhost:3000/api/zero/slack/oauth/callback?code=second-code&state=${encodeURIComponent(reinstallState)}`,
    );
    const response = await GET(secondRequest);

    expect(response.status).toBe(307);
    const location = response.headers.get("Location");
    expect(location).toContain("/?tab=works&updated=1");
  });
});
