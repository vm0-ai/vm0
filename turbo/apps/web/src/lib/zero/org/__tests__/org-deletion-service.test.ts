import { describe, it, expect } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestSecret,
  createTestVariable,
  createTestAgentSession,
  findTestRunRecord,
  findTestQueueEntry,
  insertOrgDefaultModelProvider,
  insertTestQueueEntry,
  insertTestCreditUsageForRun,
  insertTestConversation,
  insertTestStorage,
  insertTestStorageVersion,
  insertTestUsageDaily,
  insertTestExportJob,
  insertOrgMembersCacheEntry,
  insertOrgMembersEntry,
  countOrgRows,
  createTestSchedule,
  insertTestPlatformConnector,
} from "../../../../__tests__/api-test-helpers";
import { createTestEmailThreadSession } from "../../../../__tests__/db-test-seeders/email";
import {
  insertTestOrgSentinelSecret,
  insertTestOrgSentinelVariable,
} from "../../../../__tests__/db-test-seeders/secrets";
import {
  insertTestSlackOrgInstallation,
  insertTestSlackOrgConnection,
  insertTestSlackOrgThreadSession,
} from "../../../../__tests__/db-test-seeders/slack";
import { findTestSlackOrgInstallation } from "../../../../__tests__/db-test-assertions/slack";
import { createTestZeroAgent } from "../../../../__tests__/db-test-seeders/agents";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route
import { deleteOrgData } from "../org-deletion-service";
import { seedTestRun } from "../../../../__tests__/db-test-seeders/runs";

const context = testContext();

describe("deleteOrgData", () => {
  it("should complete without error for a nonexistent org (idempotency)", async () => {
    context.setupMocks();
    await context.setupUser();

    await expect(
      deleteOrgData("org_nonexistent_test"),
    ).resolves.toBeUndefined();
  });

  it("should cancel running runs and delete queue entries", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

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

    await deleteOrgData(orgId);

    expect(await findTestRunRecord(queuedRunId)).toBeUndefined();
    expect(await findTestRunRecord(pendingRunId)).toBeUndefined();
    expect(await findTestRunRecord(runningRunId)).toBeUndefined();
    expect(await findTestQueueEntry(queuedRunId)).toBeUndefined();
  });

  it("should cascade delete agent composes and children", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    const { composeId } = await createTestCompose("cascade-compose-test");
    await createTestAgentSession(userId, composeId);

    await deleteOrgData(orgId);

    expect(await countOrgRows("agent_composes", orgId)).toBe(0);
    expect(await countOrgRows("agent_sessions", orgId)).toBe(0);
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

    await deleteOrgData(orgId);

    expect(await countOrgRows("agent_runs", orgId)).toBe(0);
    // credit_usage preserved permanently (runId set to NULL)
    expect(await countOrgRows("credit_usage", orgId)).toBe(1);
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

    await deleteOrgData(orgId);

    expect(await countOrgRows("storages", orgId)).toBe(0);
  });

  it("should cascade delete secrets and model providers", async () => {
    context.setupMocks();
    const { orgId } = await context.setupUser();

    await createTestSecret("TEST_KEY", "test-value");
    await insertOrgDefaultModelProvider(orgId, "anthropic");

    await deleteOrgData(orgId);

    expect(await countOrgRows("secrets", orgId)).toBe(0);
    expect(await countOrgRows("model_providers", orgId)).toBe(0);
  });

  it("should delete independent tables", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await createTestVariable("TEST_VAR", "test-value");
    await createTestCompose("test-zero-agent");
    await createTestZeroAgent(orgId, "test-zero-agent", {
      displayName: "Test",
    });
    await insertTestUsageDaily({ userId, orgId, date: "2026-01-01" });
    await insertTestExportJob(orgId, { userId, status: "completed" });

    await deleteOrgData(orgId);

    expect(await countOrgRows("variables", orgId)).toBe(0);
    expect(await countOrgRows("zero_agents", orgId)).toBe(0);
    expect(await countOrgRows("usage_daily", orgId)).toBe(0);
    expect(await countOrgRows("export_jobs", orgId)).toBe(0);
  });

  it("should clean up Slack installation and connections", async () => {
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
    await createTestAgentSession(userId, composeId);

    await insertTestSlackOrgThreadSession({ connectionId: connection.id });

    await deleteOrgData(orgId);

    expect(await findTestSlackOrgInstallation(workspaceId)).toBeUndefined();
    expect(await countOrgRows("slack_org_installations", orgId)).toBe(0);
  });

  it("should delete membership and org identity tables", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    await insertOrgMembersCacheEntry({ orgId, userId, role: "admin" });
    await insertOrgMembersEntry({ orgId, userId });

    await deleteOrgData(orgId);

    expect(await countOrgRows("org_members_cache", orgId)).toBe(0);
    expect(await countOrgRows("org_members_metadata", orgId)).toBe(0);
    expect(await countOrgRows("org_cache", orgId)).toBe(0);
    expect(await countOrgRows("org_metadata", orgId)).toBe(0);
  });

  it("should delete all data in a fully populated org", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    // Composes, sessions, runs
    const { composeId, agentId } = await createTestCompose("full-org-test");
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

    // Secrets + model providers
    await createTestSecret("FULL_TEST_KEY", "value");
    await insertOrgDefaultModelProvider(orgId, "anthropic");

    // Variables, zero agents, schedules, usage, exports
    await createTestVariable("FULL_TEST_VAR", "value");
    await createTestZeroAgent(orgId, "full-org-test", {
      displayName: "Full Test",
    });
    await createTestSchedule(composeId, "full-org-schedule");
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
    await insertTestSlackOrgConnection({
      slackUserId: uniqueId("slack-user"),
      slackWorkspaceId: workspaceId,
      vm0UserId: userId,
    });

    // Membership
    await insertOrgMembersCacheEntry({ orgId, userId, role: "admin" });
    await insertOrgMembersEntry({ orgId, userId });

    // Platform connector enablement — separate table from OAuth, must also
    // be cascaded on org deletion. The table stores varchar, so any string
    // value exercises the delete path regardless of which (if any) platform
    // connector is currently registered in the contract.
    await insertTestPlatformConnector(orgId, userId, "__test_platform__");

    // Execute deletion
    await deleteOrgData(orgId);

    // Verify ALL tables are empty for this org (except credit_usage — preserved for audit)
    const tables = [
      "agent_runs",
      "agent_run_queue",
      "agent_composes",
      "storages",
      "secrets",
      "model_providers",
      "connectors",
      "user_platform_connectors",
      "variables",
      "usage_daily",
      "export_jobs",
      "zero_agents",
      "zero_agent_schedules",
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
  });

  it("should delete org-level sentinel resources (userId = __org__)", async () => {
    context.setupMocks();
    const { orgId } = await context.setupUser();

    // Create org-level sentinel resources
    await insertTestOrgSentinelSecret({ orgId, name: "ORG_API_KEY" });
    await insertTestOrgSentinelVariable({ orgId, name: "ORG_CONFIG" });
    await insertOrgDefaultModelProvider(orgId, "anthropic");

    // Also create a user-level secret to ensure both are deleted
    await createTestSecret("USER_KEY", "user-value");

    await deleteOrgData(orgId);

    expect(await countOrgRows("secrets", orgId)).toBe(0);
    expect(await countOrgRows("variables", orgId)).toBe(0);
    expect(await countOrgRows("model_providers", orgId)).toBe(0);
  });

  it("should be idempotent — calling twice produces no errors", async () => {
    context.setupMocks();
    const { userId, orgId } = await context.setupUser();

    const { composeId } = await createTestCompose("idempotent-test");
    await seedTestRun(userId, composeId, {
      status: "running",
      startedAt: new Date(),
    });
    await createTestSecret("IDEM_KEY", "value");

    await deleteOrgData(orgId);
    await expect(deleteOrgData(orgId)).resolves.toBeUndefined();
  });
});
