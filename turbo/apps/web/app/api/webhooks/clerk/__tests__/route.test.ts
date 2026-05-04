import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { HttpResponse } from "msw";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { http } from "../../../../../src/__tests__/msw";
import { server } from "../../../../../src/mocks/server";
import { reloadEnv } from "../../../../../src/env";
import {
  createTestCompose,
  createTestSecret,
  createTestVariable,
  createTestAgentSession,
  insertOrgDefaultModelProvider,
  insertTestStorage,
  insertTestStorageVersion,
  insertTestUsageDaily,
  insertTestExportJob,
  insertOrgMembersCacheEntry,
  insertOrgMembersEntry,
  countOrgRows,
  countUserRows,
  countGithubUserLinkRows,
  countTelegramUserLinkRows,
  updateOrgStripeSubscription,
  createTelegramInstallationForCompose,
  createTestCliToken,
  createTestDeviceCode,
  createTestConnectorSession,
  insertTestGithubInstallation,
  insertTestGithubUserLink,
  insertTestTelegramInstallation,
  insertTestTelegramUserLink,
  insertUserCacheEntry,
  insertOrgCacheEntry,
} from "../../../../../src/__tests__/api-test-helpers";
import { createTestEmailThreadSession } from "../../../../../src/__tests__/db-test-seeders/email";
import {
  insertTestSlackOrgInstallation,
  insertTestSlackOrgConnection,
  insertTestSlackOrgThreadSession,
} from "../../../../../src/__tests__/db-test-seeders/slack";
import { countSlackConnectionRows } from "../../../../../src/__tests__/db-test-assertions/slack";
import {
  createTestZeroAgent,
  updateAgentComposeOrg,
  insertTestComposeJob,
} from "../../../../../src/__tests__/db-test-seeders/agents";

// Mock @clerk/nextjs/webhooks (external dependency)
const mockVerifyWebhook = vi.hoisted(() => {
  return vi.fn();
});
vi.mock("@clerk/nextjs/webhooks", () => {
  return {
    verifyWebhook: mockVerifyWebhook,
  };
});

// Mock stripe (external dependency)
const stripeMocks = vi.hoisted(() => {
  return {
    subscriptionsCancel: vi.fn(),
  };
});
vi.mock("stripe", () => {
  return {
    default: function MockStripe() {
      return {
        subscriptions: {
          cancel: stripeMocks.subscriptionsCancel,
        },
      };
    },
  };
});

// Import route handler AFTER mocks are set up
import { POST } from "../route";
import { seedTestRun } from "../../../../../src/__tests__/db-test-seeders/runs";

const context = testContext();

/** Helper to send a webhook request through the route */
function createWebhookRequest(): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/clerk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("POST /api/webhooks/clerk", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("returns 401 when signature verification fails", async () => {
    mockVerifyWebhook.mockRejectedValue(new Error("Invalid signature"));

    const response = await POST(createWebhookRequest());

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toContain("Invalid webhook signature");
  });

  it("returns 200 for unhandled event types", async () => {
    mockVerifyWebhook.mockResolvedValue({
      type: "user.created",
      data: { id: "user_test123" },
    });

    const response = await POST(createWebhookRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
  });

  it("calls verifyWebhook with the request", async () => {
    mockVerifyWebhook.mockResolvedValue({
      type: "user.created",
      data: { id: "user_test123" },
    });

    const request = createWebhookRequest();
    await POST(request);

    expect(mockVerifyWebhook).toHaveBeenCalledWith(request);
  });

  describe("organization.deleted cleanup", () => {
    it("returns 200 and runs cleanup pipeline for a valid org ID", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "organization.deleted",
        data: { object: "organization", id: "org_test123", deleted: true },
      });

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      // Cleanup runs in background via after(); flush to ensure it completes
      await context.mocks.flushAfter();
    });

    it("handles missing org ID gracefully", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "organization.deleted",
        data: { object: "organization", id: undefined, deleted: true },
      });

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();
    });

    it("returns 200 and does not propagate cleanup errors to the response", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "organization.deleted",
        data: { object: "organization", id: "org_fail", deleted: true },
      });

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      // flushAfter should not throw — error is caught inside the after() callback
      await expect(context.mocks.flushAfter()).resolves.toBeUndefined();
    });
  });

  describe("organizationMembership.deleted", () => {
    it("returns 200 as a no-op", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "organizationMembership.deleted",
        data: {
          object: "organization_membership",
          organization: { id: "org_test123" },
          public_user_data: { user_id: "user_test456" },
        },
      });

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();
    });
  });

  describe("user.deleted cleanup", () => {
    it("returns 200 and runs cleanup pipeline for a valid user ID", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "user.deleted",
        data: { object: "user", id: "user_test123", deleted: true },
      });

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      // Cleanup runs in background via after(); flush to ensure it completes
      await context.mocks.flushAfter();
    });

    it("handles missing user ID gracefully", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "user.deleted",
        data: { object: "user", id: undefined, deleted: true },
      });

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      await context.mocks.flushAfter();
    });

    it("returns 200 and does not propagate cleanup errors to the response", async () => {
      mockVerifyWebhook.mockResolvedValue({
        type: "user.deleted",
        data: { object: "user", id: "user_fail", deleted: true },
      });

      const response = await POST(createWebhookRequest());
      expect(response.status).toBe(200);

      // flushAfter should not throw — error is caught inside the after() callback
      await expect(context.mocks.flushAfter()).resolves.toBeUndefined();
    });
  });
});

/**
 * E2E test block — cleanup functions run for real (no spies).
 * Separate from the dispatch tests above to avoid inheriting the
 * beforeEach that spy-mocks cleanupOrgExternalServices / deleteOrgS3Data / deleteOrgData.
 */
describe("organization.deleted e2e cleanup", () => {
  beforeEach(() => {
    // Restore spies from the dispatch-test describe block so cleanup
    // functions execute for real instead of returning undefined.
    vi.restoreAllMocks();
    context.setupMocks();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    reloadEnv();
    stripeMocks.subscriptionsCancel.mockResolvedValue({ id: "sub_cancelled" });
  });

  it("deletes all org data through the full pipeline", async () => {
    const { userId, orgId } = await context.setupUser();

    // --- Populate org with data across all table types ---

    // Composes + sessions + runs
    const { composeId, agentId } = await createTestCompose(
      uniqueId("e2e-org-test"),
    );
    const session = await createTestAgentSession(userId, composeId);
    await seedTestRun(userId, composeId, {
      status: "running",
      startedAt: new Date(),
    });

    // Email thread session
    await createTestEmailThreadSession({
      userId,
      agentId,
      agentSessionId: session.id,
      replyToToken: uniqueId("reply"),
    });

    // Storage with s3Prefix
    await insertTestStorage({ userId, orgId, name: "e2e-volume" });

    // Secret + model provider
    await createTestSecret("E2E_KEY", "e2e-value");
    await insertOrgDefaultModelProvider(orgId, "anthropic");

    // Connector
    await context.createConnector(orgId, { userId, type: "github" });

    // Variable
    await createTestVariable("E2E_VAR", "e2e-value");

    // Export job with s3Key
    await insertTestExportJob(orgId, {
      userId,
      status: "completed",
      s3Key: "exports/e2e.zip",
    });

    // Zero agent (need compose first since zero_agents.id = composeId)
    const zeroAgentName = uniqueId("e2e-zero-agent");
    await createTestCompose(zeroAgentName);
    await createTestZeroAgent(orgId, zeroAgentName, {
      displayName: "E2E",
    });

    // Usage daily
    await insertTestUsageDaily({ userId, orgId, date: "2026-01-01" });

    // Storage version
    const storage2 = await insertTestStorage({
      userId,
      orgId,
      name: "e2e-volume-2",
    });
    await insertTestStorageVersion({
      storageId: storage2.id,
      createdBy: userId,
    });

    // Slack installation + connection
    const workspaceId = uniqueId("ws");
    await insertTestSlackOrgInstallation({
      slackWorkspaceId: workspaceId,
      slackWorkspaceName: "E2E Workspace",
      orgId,
      installedByUserId: userId,
    });
    await insertTestSlackOrgConnection({
      slackUserId: uniqueId("slack-user"),
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    });

    // Membership + org identity
    await insertOrgMembersCacheEntry({ orgId, userId, role: "admin" });
    await insertOrgMembersEntry({ orgId, userId });

    // --- External service setup ---

    // Stripe subscription
    const subId = uniqueId("sub");
    await updateOrgStripeSubscription(orgId, subId, "active");

    // Telegram installation (needs compose linked to org)
    const compose2 = await context.createAgentCompose(userId, {
      name: uniqueId("tg-compose"),
    });
    await updateAgentComposeOrg(compose2.id, orgId);
    const botToken = "e2e-bot-token";
    await createTelegramInstallationForCompose(compose2.id, userId, botToken);

    const telegramHandler = http.post(
      `https://api.telegram.org/bot${botToken}/deleteWebhook`,
      () => {
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    server.use(telegramHandler.handler);

    // --- Send webhook ---
    mockVerifyWebhook.mockResolvedValue({
      type: "organization.deleted",
      data: { object: "organization", id: orgId, deleted: true },
    });

    const response = await POST(createWebhookRequest());
    expect(response.status).toBe(200);

    await context.mocks.flushAfter();

    // --- Verify ALL org-scoped tables are empty ---
    const tables = [
      "agent_runs",
      "agent_run_queue",
      "agent_composes",
      "storages",
      "secrets",
      "model_providers",
      "connectors",
      "variables",
      "usage_daily",
      "usage_event",
      "export_jobs",
      "zero_agents",
      "agent_sessions",
      "email_thread_sessions",
      "slack_org_installations",
      "org_members_cache",
      "org_members_metadata",
      "org_cache",
      "org_metadata",
    ] as const;

    for (const table of tables) {
      expect(
        await countOrgRows(table, orgId),
        `Expected 0 rows in ${table}`,
      ).toBe(0);
    }

    // --- Verify external service cleanup ---
    expect(stripeMocks.subscriptionsCancel).toHaveBeenCalledWith(subId);
    expect(telegramHandler.mocked).toHaveBeenCalledTimes(1);
    expect(context.mocks.s3.listS3Objects).toHaveBeenCalled();
  });
});

/**
 * E2E test block for user.deleted — cleanup functions run for real (no spies).
 * Separate describe block to avoid inheriting spy-mocks from the dispatch tests.
 */
describe("user.deleted e2e cleanup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    context.setupMocks();
  });

  it("deletes all user data through the full pipeline", async () => {
    const { userId, orgId } = await context.setupUser();

    // Create a second org to verify cross-org membership cleanup
    const orgId2 = uniqueId("org");
    await insertOrgCacheEntry({ orgId: orgId2, slug: "second-org" });

    // --- Populate user data across all table types ---

    // Composes + sessions + runs
    const { composeId, agentId } = await createTestCompose(
      uniqueId("e2e-user-test"),
    );
    const session = await createTestAgentSession(userId, composeId);
    await seedTestRun(userId, composeId, {
      status: "running",
      startedAt: new Date(),
    });

    // Email thread session
    await createTestEmailThreadSession({
      userId,
      agentId,
      agentSessionId: session.id,
      replyToToken: uniqueId("reply"),
    });

    // Storage with s3Prefix
    await insertTestStorage({ userId, orgId, name: "e2e-user-volume" });

    // Secret + model provider
    await createTestSecret("E2E_USER_KEY", "e2e-value");
    await insertOrgDefaultModelProvider(orgId, "anthropic");

    // Connector
    await context.createConnector(orgId, { userId, type: "github" });

    // Variable
    await createTestVariable("E2E_USER_VAR", "e2e-value");

    // Export job with s3Key
    await insertTestExportJob(orgId, {
      userId,
      status: "completed",
      s3Key: "exports/e2e-user.zip",
    });

    // Usage daily
    await insertTestUsageDaily({ userId, orgId, date: "2026-01-01" });

    // Slack installation + connection
    const workspaceId = uniqueId("ws");
    await insertTestSlackOrgInstallation({
      slackWorkspaceId: workspaceId,
      slackWorkspaceName: "E2E User Workspace",
      orgId,
      installedByUserId: userId,
    });
    const connection = await insertTestSlackOrgConnection({
      slackUserId: uniqueId("slack-user"),
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    });
    await insertTestSlackOrgThreadSession({
      connectionId: connection.id,
    });

    // GitHub user link (needs a github installation first)
    const ghInstall = await insertTestGithubInstallation({
      composeId,
    });
    await insertTestGithubUserLink({
      installationId: ghInstall.id,
      githubUserId: "123456",
      vm0UserId: userId,
    });

    // Telegram user link (needs a telegram installation first)
    const tgInstall = await insertTestTelegramInstallation({
      composeId,
      ownerUserId: userId,
    });
    await insertTestTelegramUserLink({
      installationId: tgInstall.telegramBotId,
      telegramUserId: "654321",
      vm0UserId: userId,
    });

    // User-only tables
    await createTestCliToken(userId);
    await createTestDeviceCode({ userId, status: "authenticated" });
    await createTestConnectorSession(userId, "github");
    await insertTestComposeJob({ userId });

    // Membership in both orgs
    await insertOrgMembersCacheEntry({ orgId, userId, role: "admin" });
    await insertOrgMembersEntry({ orgId, userId });
    await insertOrgMembersCacheEntry({ orgId: orgId2, userId, role: "member" });
    await insertOrgMembersEntry({ orgId: orgId2, userId });

    // User identity
    await insertUserCacheEntry({ userId, email: "e2e-user@example.com" });

    // --- Send webhook ---
    mockVerifyWebhook.mockResolvedValue({
      type: "user.deleted",
      data: { object: "user", id: userId, deleted: true },
    });

    const response = await POST(createWebhookRequest());
    expect(response.status).toBe(200);

    await context.mocks.flushAfter();

    // --- Verify ALL user-scoped tables are empty ---
    const userIdTables = [
      "agent_runs",
      "agent_run_queue",
      "agent_composes",
      "storages",
      "secrets",
      "model_providers",
      "connectors",
      "variables",
      "usage_daily",
      "export_jobs",
      "cli_tokens",
      "compose_jobs",
      "connector_sessions",
      "device_codes",
      "org_members_cache",
      "org_members_metadata",
      "user_cache",
      "users",
    ] as const;

    for (const table of userIdTables) {
      expect(
        await countUserRows(table, userId),
        `Expected 0 rows in ${table}`,
      ).toBe(0);
    }

    // vm0UserId-based tables
    expect(await countSlackConnectionRows(userId)).toBe(0);
    expect(await countGithubUserLinkRows(userId)).toBe(0);
    expect(await countTelegramUserLinkRows(userId)).toBe(0);

    // --- Verify org-level data is untouched ---
    // Org cache and slack installations should survive user deletion
    expect(await countOrgRows("org_cache", orgId)).toBe(1);
    expect(await countOrgRows("slack_org_installations", orgId)).toBe(1);

    // S3 cleanup should have been attempted
    expect(context.mocks.s3.listS3Objects).toHaveBeenCalled();
  });
});
