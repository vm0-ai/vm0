import { describe, it, expect } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestSecret,
  createTestVariable,
  createTestAgentSession,
  createTestEmailThreadSession,
  createTestCliToken,
  createTestDeviceCode,
  createTestConnectorSession,
  findTestRunRecord,
  findTestQueueEntry,
  insertTestQueueEntry,
  insertTestSlackOrgInstallation,
  insertTestSlackOrgConnection,
  insertTestSlackOrgThreadSession,
  insertTestCreditUsageForRun,
  insertTestConversation,
  insertTestStorage,
  insertTestStorageVersion,
  insertTestUsageDaily,
  insertTestExportJob,
  insertOrgMembersCacheEntry,
  insertOrgMembersEntry,
  insertUserCacheEntry,
  countUserRows,
  countSlackConnectionRows,
  countGithubUserLinkRows,
  countTelegramUserLinkRows,
  insertTestGithubInstallation,
  insertTestGithubUserLink,
  insertTestTelegramInstallation,
  insertTestTelegramUserLink,
} from "../../../../__tests__/api-test-helpers";
import { insertTestComposeJob } from "../../../../__tests__/db-test-seeders/agents";
import { deleteUserData } from "../user-deletion-service";
import { seedTestRun } from "../../../../__tests__/db-test-seeders/runs";

const context = testContext();

describe("deleteUserData", () => {
  it("should complete without error for a nonexistent user (idempotency)", async () => {
    context.setupMocks();
    await context.setupUser();

    await expect(
      deleteUserData("user_nonexistent_test"),
    ).resolves.toBeUndefined();
  });

  it("should cancel running runs and delete queue entries", async () => {
    context.setupMocks();
    const { userId } = await context.setupUser();

    const { composeId } = await createTestCompose("cancel-test");
    const { runId: queuedRunId } = await seedTestRun(userId, composeId, {
      status: "queued",
    });
    const { runId: pendingRunId } = await seedTestRun(userId, composeId, {
      status: "pending",
    });
    const { runId: runningRunId } = await seedTestRun(userId, composeId, {
      status: "running",
      startedAt: new Date(),
    });
    await seedTestRun(userId, composeId, {
      status: "completed",
      completedAt: new Date(),
    });

    await insertTestQueueEntry(queuedRunId);

    await deleteUserData(userId);

    expect(await findTestRunRecord(queuedRunId)).toBeUndefined();
    expect(await findTestRunRecord(pendingRunId)).toBeUndefined();
    expect(await findTestRunRecord(runningRunId)).toBeUndefined();
    expect(await findTestQueueEntry(queuedRunId)).toBeUndefined();
  });

  it("should cascade delete agent composes and children", async () => {
    context.setupMocks();
    const { userId } = await context.setupUser();

    const { composeId } = await createTestCompose("cascade-compose-test");
    await createTestAgentSession(userId, composeId);

    await deleteUserData(userId);

    expect(await countUserRows("agent_composes", userId)).toBe(0);
  });

  it("should cascade delete agent runs and children", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    const { composeId } = await createTestCompose("cascade-run-test");
    const { runId } = await seedTestRun(userId, composeId, {
      status: "completed",
      completedAt: new Date(),
    });

    await insertTestCreditUsageForRun({ runId, orgId, userId });
    await insertTestConversation({ runId });

    await deleteUserData(userId);

    expect(await countUserRows("agent_runs", userId)).toBe(0);
  });

  it("should cascade delete storages and versions", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    const storage = await insertTestStorage({
      userId,
      orgId,
      name: "test-volume",
    });
    await insertTestStorageVersion({
      storageId: storage.id,
      createdBy: userId,
    });

    await deleteUserData(userId);

    expect(await countUserRows("storages", userId)).toBe(0);
  });

  it("should cascade delete secrets and model providers", async () => {
    context.setupMocks();
    const { userId } = await context.setupUser();

    await createTestSecret("TEST_KEY", "test-value");

    await deleteUserData(userId);

    expect(await countUserRows("secrets", userId)).toBe(0);
    expect(await countUserRows("model_providers", userId)).toBe(0);
  });

  it("should delete independent tables", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await createTestVariable("TEST_VAR", "test-value");
    await insertTestUsageDaily({ userId, orgId, date: "2026-01-01" });
    await insertTestExportJob(orgId, { userId, status: "completed" });

    await deleteUserData(userId);

    expect(await countUserRows("variables", userId)).toBe(0);
    expect(await countUserRows("usage_daily", userId)).toBe(0);
    expect(await countUserRows("export_jobs", userId)).toBe(0);
  });

  it("should clean up Slack connections", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    const workspaceId = uniqueId("ws");

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

    const { composeId } = await createTestCompose("slack-test");
    const session = await createTestAgentSession(userId, composeId);

    await insertTestSlackOrgThreadSession({ connectionId: connection.id });

    await deleteUserData(userId);

    expect(await countSlackConnectionRows(userId)).toBe(0);
  });

  it("should delete external service links (GitHub and Telegram)", async () => {
    context.setupMocks();
    const { userId } = await context.setupUser();

    const { composeId } = await createTestCompose("external-links-test");

    // GitHub: compose → installation → user link
    const ghInstallation = await insertTestGithubInstallation({ composeId });
    await insertTestGithubUserLink({
      installationId: ghInstallation.id,
      githubUserId: uniqueId("gh-user"),
      vm0UserId: userId,
    });

    // Telegram: compose → installation → user link
    const tgInstallation = await insertTestTelegramInstallation({
      composeId,
      adminUserId: userId,
    });
    await insertTestTelegramUserLink({
      installationId: tgInstallation.id,
      telegramUserId: uniqueId("tg-user"),
      vm0UserId: userId,
    });

    await deleteUserData(userId);

    expect(await countGithubUserLinkRows(userId)).toBe(0);
    expect(await countTelegramUserLinkRows(userId)).toBe(0);
  });

  it("should delete user-only tables (cli_tokens, compose_jobs, connector_sessions, device_codes)", async () => {
    context.setupMocks();
    const { userId } = await context.setupUser();

    await createTestCliToken(userId);
    await createTestDeviceCode({ userId, status: "authenticated" });
    await createTestConnectorSession(userId, "github");
    await insertTestComposeJob({ userId });

    await deleteUserData(userId);

    expect(await countUserRows("cli_tokens", userId)).toBe(0);
    expect(await countUserRows("device_codes", userId)).toBe(0);
    expect(await countUserRows("connector_sessions", userId)).toBe(0);
    expect(await countUserRows("compose_jobs", userId)).toBe(0);
  });

  it("should delete membership across multiple orgs", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await insertOrgMembersCacheEntry({ orgId, userId, role: "admin" });
    await insertOrgMembersEntry({ orgId, userId });

    await deleteUserData(userId);

    expect(await countUserRows("org_members_cache", userId)).toBe(0);
    expect(await countUserRows("org_members_metadata", userId)).toBe(0);
  });

  it("should delete user identity (user_cache, users)", async () => {
    context.setupMocks();
    const { userId } = await context.setupUser();

    await insertUserCacheEntry({ userId, email: "test@example.com" });

    await deleteUserData(userId);

    expect(await countUserRows("user_cache", userId)).toBe(0);
    expect(await countUserRows("users", userId)).toBe(0);
  });

  it("should delete all data in a fully populated user", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    // Composes, sessions, runs
    const { composeId, agentId } = await createTestCompose("full-user-test");
    const session = await createTestAgentSession(userId, composeId);
    const { runId } = await seedTestRun(userId, composeId, {
      status: "running",
      startedAt: new Date(),
    });

    await insertTestCreditUsageForRun({ runId, orgId, userId });
    await insertTestConversation({ runId });
    await insertTestQueueEntry(runId);

    // Storage
    const storage = await insertTestStorage({
      userId,
      orgId,
      name: "full-test-volume",
    });
    await insertTestStorageVersion({
      storageId: storage.id,
      createdBy: userId,
    });

    // Secrets
    await createTestSecret("FULL_TEST_KEY", "value");

    // Variables, usage, exports
    await createTestVariable("FULL_TEST_VAR", "value");
    await insertTestUsageDaily({ userId, orgId, date: "2026-03-01" });
    await insertTestExportJob(orgId, { userId, status: "completed" });

    // Email thread session
    await createTestEmailThreadSession({
      userId,
      agentId,
      agentSessionId: session.id,
      replyToToken: uniqueId("reply"),
    });

    // Slack
    const workspaceId = uniqueId("ws");
    await insertTestSlackOrgInstallation({
      slackWorkspaceId: workspaceId,
      slackWorkspaceName: "Full Test Workspace",
      orgId,
      installedByUserId: userId,
    });
    const connection = await insertTestSlackOrgConnection({
      slackUserId: uniqueId("slack-user"),
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    });

    // User-only tables
    await createTestCliToken(userId);
    await createTestDeviceCode({ userId, status: "authenticated" });
    await createTestConnectorSession(userId, "github");
    await insertTestComposeJob({ userId });

    // Membership
    await insertOrgMembersCacheEntry({ orgId, userId, role: "admin" });
    await insertOrgMembersEntry({ orgId, userId });

    // User identity
    await insertUserCacheEntry({ userId, email: "full-test@example.com" });

    // Execute deletion
    await deleteUserData(userId);

    // Verify ALL user-scoped tables are empty
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
      "zero_agent_schedules",
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
  });

  it("should be idempotent — calling twice produces no errors", async () => {
    context.setupMocks();
    const { userId } = await context.setupUser();

    const { composeId } = await createTestCompose("idempotent-test");
    await seedTestRun(userId, composeId, {
      status: "running",
      startedAt: new Date(),
    });
    await createTestSecret("IDEM_KEY", "value");

    await deleteUserData(userId);
    await expect(deleteUserData(userId)).resolves.toBeUndefined();
  });
});
