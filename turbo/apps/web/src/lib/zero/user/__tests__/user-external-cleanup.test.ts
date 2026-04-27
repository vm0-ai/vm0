import { describe, it, expect, beforeEach } from "vitest";
import { HttpResponse } from "msw";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  insertTestGitHubUserLink,
  insertTestGitHubInstallation,
  createTestTelegramInstallation,
  createTelegramInstallationForCompose,
  findTestGitHubUserLinksByVm0UserId,
  findTestTelegramInstallationsByOwner,
  findTestTelegramUserLinksByVm0UserId,
} from "../../../../__tests__/api-test-helpers";
import {
  insertTestSlackOrgInstallation,
  insertTestSlackOrgConnection,
  insertTestSlackOrgThreadSession,
} from "../../../../__tests__/db-test-seeders/slack";
import { findTestSlackOrgConnectionsByVm0UserId } from "../../../../__tests__/db-test-assertions/slack";
import { http } from "../../../../__tests__/msw";
import { server } from "../../../../mocks/server";
import { cleanupUserExternalServices } from "../user-external-cleanup";

const context = testContext();

describe("cleanupUserExternalServices", () => {
  let userId: string;
  let orgId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    orgId = user.orgId;
  });

  it("completes without error when user has no external services", async () => {
    await cleanupUserExternalServices(userId);
  });

  it("revokes connector tokens for user connectors across orgs", async () => {
    // revokeConnectorToken will skip gracefully since OAuth credentials
    // are not configured in the test environment — best-effort by design
    await context.createConnector(orgId, { userId, type: "github" });

    // Should complete without error even with no OAuth creds configured
    await cleanupUserExternalServices(userId);
  });

  it("deletes github user links", async () => {
    const compose = await context.createAgentCompose(userId);
    const installation = await insertTestGitHubInstallation(compose.id);

    await insertTestGitHubUserLink(
      uniqueId("gh-user"),
      installation.id,
      userId,
    );

    await cleanupUserExternalServices(userId);

    const remaining = await findTestGitHubUserLinksByVm0UserId(userId);
    expect(remaining).toHaveLength(0);
  });

  it("deletes telegram user links", async () => {
    await createTestTelegramInstallation({
      ownerUserId: userId,
      vm0UserId: userId,
    });

    // Verify link exists before cleanup
    const before = await findTestTelegramUserLinksByVm0UserId(userId);
    expect(before.length).toBeGreaterThan(0);

    await cleanupUserExternalServices(userId);

    const after = await findTestTelegramUserLinksByVm0UserId(userId);
    expect(after).toHaveLength(0);
  });

  it("deletes owned telegram installations and deregisters webhooks", async () => {
    const compose = await context.createAgentCompose(userId);
    const botToken = `owned-bot-token-${uniqueId("t")}`;
    await createTelegramInstallationForCompose(compose.id, userId, botToken);

    const telegramHandler = http.post(
      `https://api.telegram.org/bot${botToken}/deleteWebhook`,
      () => {
        return HttpResponse.json({ ok: true, result: true });
      },
    );
    server.use(telegramHandler.handler);

    // Verify installation exists before cleanup
    const before = await findTestTelegramInstallationsByOwner(userId);
    expect(before).toHaveLength(1);

    await cleanupUserExternalServices(userId);

    // Webhook deregistration attempted
    expect(telegramHandler.mocked).toHaveBeenCalledTimes(1);

    // Installation row deleted (cascades user links, thread sessions, messages)
    const after = await findTestTelegramInstallationsByOwner(userId);
    expect(after).toHaveLength(0);
  });

  it("deletes owned telegram installations even when deleteWebhook fails", async () => {
    const compose = await context.createAgentCompose(userId);
    const botToken = `owned-fail-token-${uniqueId("t")}`;
    await createTelegramInstallationForCompose(compose.id, userId, botToken);

    const failHandler = http.post(
      `https://api.telegram.org/bot${botToken}/deleteWebhook`,
      () => {
        return HttpResponse.error();
      },
    );
    server.use(failHandler.handler);

    await cleanupUserExternalServices(userId);

    expect(failHandler.mocked).toHaveBeenCalledTimes(1);

    // DB row is still deleted despite the Telegram API failure
    const after = await findTestTelegramInstallationsByOwner(userId);
    expect(after).toHaveLength(0);
  });

  it("deletes slack connections", async () => {
    const workspaceId = uniqueId("W");
    await insertTestSlackOrgInstallation({
      slackWorkspaceId: workspaceId,
      slackWorkspaceName: "Test Workspace",
      orgId,
      installedByUserId: userId,
    });

    await insertTestSlackOrgConnection({
      slackUserId: uniqueId("slack-user"),
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    });

    await cleanupUserExternalServices(userId);

    // Connections should be deleted
    const remainingConnections =
      await findTestSlackOrgConnectionsByVm0UserId(userId);
    expect(remainingConnections).toHaveLength(0);
  });

  it("deletes slack connections with thread sessions (cascade)", async () => {
    const workspaceId = uniqueId("W");
    await insertTestSlackOrgInstallation({
      slackWorkspaceId: workspaceId,
      slackWorkspaceName: "Test Workspace",
      orgId,
      installedByUserId: userId,
    });

    const connection = await insertTestSlackOrgConnection({
      slackUserId: uniqueId("slack-user"),
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    });

    // Thread sessions have cascade delete on connectionId
    await insertTestSlackOrgThreadSession({ connectionId: connection.id });

    await cleanupUserExternalServices(userId);

    // Connections should be deleted (thread sessions cascade automatically)
    const remainingConnections =
      await findTestSlackOrgConnectionsByVm0UserId(userId);
    expect(remainingConnections).toHaveLength(0);
  });

  it("continues cleanup when one step fails (best-effort)", async () => {
    // Create a telegram user link that should be cleaned up
    await createTestTelegramInstallation({
      ownerUserId: userId,
      vm0UserId: userId,
    });

    // Create a connector that will fail during revocation attempt
    // (OAuth credentials not configured — but step should not block other steps)
    await context.createConnector(orgId, { userId, type: "github" });

    await cleanupUserExternalServices(userId);

    // Telegram links should still be cleaned up even if connector revocation had issues
    const remainingTelegramLinks =
      await findTestTelegramUserLinksByVm0UserId(userId);
    expect(remainingTelegramLinks).toHaveLength(0);
  });

  it("is idempotent - calling twice produces no errors", async () => {
    await createTestTelegramInstallation({
      ownerUserId: userId,
      vm0UserId: userId,
    });

    await cleanupUserExternalServices(userId);
    await cleanupUserExternalServices(userId);

    const remaining = await findTestTelegramUserLinksByVm0UserId(userId);
    expect(remaining).toHaveLength(0);
  });
});
