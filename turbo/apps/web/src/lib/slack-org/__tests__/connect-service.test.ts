import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { uniqueId } from "../../../__tests__/test-helpers";
import { initServices } from "../../init-services";
import { slackOrgInstallations } from "../../../db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../db/schema/slack-org-connection";
import { cleanupWorkspaceInstallation } from "../connect-service";

beforeAll(() => {
  initServices();
});

describe("cleanupWorkspaceInstallation", () => {
  it("should delete installation and all connections for a workspace", async () => {
    const db = globalThis.services.db;
    const workspaceId = uniqueId("T-ws");

    // Seed installation
    await db.insert(slackOrgInstallations).values({
      slackWorkspaceId: workspaceId,
      encryptedBotToken: "encrypted-token",
      botUserId: "B001",
      orgId: uniqueId("org"),
    });

    // Seed connections
    await db.insert(slackOrgConnections).values([
      {
        slackUserId: "U001",
        slackWorkspaceId: workspaceId,
        vm0UserId: uniqueId("user"),
      },
      {
        slackUserId: "U002",
        slackWorkspaceId: workspaceId,
        vm0UserId: uniqueId("user"),
      },
    ]);

    const result = await cleanupWorkspaceInstallation(workspaceId);

    expect(result).toBe(true);

    // Verify installation deleted
    const installations = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));
    expect(installations).toHaveLength(0);

    // Verify connections deleted
    const connections = await db
      .select()
      .from(slackOrgConnections)
      .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));
    expect(connections).toHaveLength(0);
  });

  it("should return false when workspace does not exist", async () => {
    const result = await cleanupWorkspaceInstallation("T-nonexistent");

    expect(result).toBe(false);
  });

  it("should handle workspace with no connections", async () => {
    const db = globalThis.services.db;
    const workspaceId = uniqueId("T-ws");

    await db.insert(slackOrgInstallations).values({
      slackWorkspaceId: workspaceId,
      encryptedBotToken: "encrypted-token",
      botUserId: "B001",
    });

    const result = await cleanupWorkspaceInstallation(workspaceId);

    expect(result).toBe(true);

    const installations = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));
    expect(installations).toHaveLength(0);
  });
});
