import { describe, it, expect } from "vitest";
import { uniqueId } from "../../../__tests__/test-helpers";
import {
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
  seedTestCompose,
  seedTestSlackOrgPendingQuestion,
  countSlackOrgInstallations,
  countSlackOrgConnections,
  countSlackOrgPendingQuestions,
} from "../../../__tests__/api-test-helpers";
import { cleanupWorkspaceInstallation } from "../connect-service";

describe("cleanupWorkspaceInstallation", () => {
  it("should delete installation and all connections for a workspace", async () => {
    const workspaceId = uniqueId("T-ws");

    await createTestSlackOrgInstallation({
      workspaceId,
      orgId: uniqueId("org"),
    });

    await seedTestSlackOrgConnection({
      slackUserId: "U001",
      slackWorkspaceId: workspaceId,
      vm0UserId: uniqueId("user"),
    });
    await seedTestSlackOrgConnection({
      slackUserId: "U002",
      slackWorkspaceId: workspaceId,
      vm0UserId: uniqueId("user"),
    });

    const result = await cleanupWorkspaceInstallation(workspaceId);

    expect(result).toBe(true);
    expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
    expect(await countSlackOrgConnections(workspaceId)).toBe(0);
  });

  it("should delete pending questions before connections", async () => {
    const workspaceId = uniqueId("T-ws");
    const orgId = uniqueId("org");

    await createTestSlackOrgInstallation({ workspaceId, orgId });

    const { connectionId } = await seedTestSlackOrgConnection({
      slackUserId: "U001",
      slackWorkspaceId: workspaceId,
      vm0UserId: uniqueId("user"),
    });

    const { composeId } = await seedTestCompose({
      userId: uniqueId("user"),
      name: uniqueId("compose"),
      orgId,
    });

    await seedTestSlackOrgPendingQuestion({
      runId: uniqueId("run"),
      slackWorkspaceId: workspaceId,
      slackChannelId: "C001",
      slackThreadTs: "1234567890.000001",
      connectionId,
      composeId,
      agentName: "test-agent",
      questions: [{ type: "text", question: "test?" }],
      expiresAt: new Date(Date.now() + 3600000),
    });
    await seedTestSlackOrgPendingQuestion({
      runId: uniqueId("run"),
      slackWorkspaceId: workspaceId,
      slackChannelId: "C002",
      slackThreadTs: "1234567890.000002",
      connectionId,
      composeId,
      agentName: "test-agent",
      questions: [{ type: "text", question: "another?" }],
      expiresAt: new Date(Date.now() + 3600000),
    });

    const result = await cleanupWorkspaceInstallation(workspaceId);

    expect(result).toBe(true);
    expect(await countSlackOrgPendingQuestions(connectionId)).toBe(0);
    expect(await countSlackOrgConnections(workspaceId)).toBe(0);
    expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
  });

  it("should return false when workspace does not exist", async () => {
    const result = await cleanupWorkspaceInstallation("T-nonexistent");

    expect(result).toBe(false);
  });

  it("should handle workspace with no connections", async () => {
    const workspaceId = uniqueId("T-ws");

    await createTestSlackOrgInstallation({ workspaceId, orgId: null });

    const result = await cleanupWorkspaceInstallation(workspaceId);

    expect(result).toBe(true);
    expect(await countSlackOrgInstallations(workspaceId)).toBe(0);
  });
});
