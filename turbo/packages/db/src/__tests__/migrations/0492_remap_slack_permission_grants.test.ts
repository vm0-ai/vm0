import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0492_remap_slack_permission_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

interface GrantRow {
  readonly connectorRef: string;
  readonly permission: string;
  readonly action: "allow" | "deny";
  readonly expiresAt: Date | null;
}

type TransactionCallback = Parameters<typeof db.transaction>[0];
type Transaction = Parameters<TransactionCallback>[0];

class RollbackMigrationTestTransaction extends Error {}

async function runInRollbackTransaction(
  callback: TransactionCallback,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await callback(tx);
      throw new RollbackMigrationTestTransaction();
    });
  } catch (error) {
    if (error instanceof RollbackMigrationTestTransaction) {
      return;
    }
    throw error;
  }
}

async function createAgent(
  tx: Transaction,
  orgId: string,
  ownerId: string,
): Promise<string> {
  const [compose] = await tx
    .insert(agentComposes)
    .values({
      orgId,
      userId: ownerId,
      name: uniqueId("compose"),
    })
    .returning({ id: agentComposes.id });
  const agentId = compose!.id;

  await tx.insert(zeroAgents).values({
    id: agentId,
    orgId,
    owner: ownerId,
    name: uniqueId("agent"),
  });

  return agentId;
}

describe("migration 0492 remap Slack permission grants", () => {
  it("remaps shared route grants, resolves conflicts, deletes removed names, and is idempotent", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const userId = uniqueId("user");
      const agentId = await createAgent(tx, orgId, ownerId);

      await tx.insert(userPermissionGrants).values([
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "channels:read",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "groups:read",
          action: "deny",
          expiresAt: new Date("2031-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "channels:history",
          action: "allow",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "channels:write",
          action: "allow",
          expiresAt: new Date("2033-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "groups:write.invites",
          action: "deny",
          expiresAt: new Date("2034-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "im:write.topic",
          action: "deny",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "search:read.public",
          action: "allow",
          expiresAt: new Date("2035-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "team:read",
          action: "deny",
          expiresAt: new Date("2036-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "channels:read",
          action: "allow",
          expiresAt: new Date("2040-01-01T00:00:00Z"),
        },
      ]);

      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql.raw(migrationSql));

      const grants: readonly GrantRow[] = await tx
        .select({
          connectorRef: userPermissionGrants.connectorRef,
          permission: userPermissionGrants.permission,
          action: userPermissionGrants.action,
          expiresAt: userPermissionGrants.expiresAt,
        })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.orgId, orgId))
        .orderBy(
          asc(userPermissionGrants.connectorRef),
          asc(userPermissionGrants.permission),
        );

      expect(grants).toStrictEqual([
        {
          connectorRef: "gmail",
          permission: "channels:read",
          action: "allow",
          expiresAt: new Date("2040-01-01T00:00:00Z"),
        },
        {
          connectorRef: "slack",
          permission: "assistant.search:read",
          action: "allow",
          expiresAt: new Date("2035-01-01T00:00:00Z"),
        },
        {
          connectorRef: "slack",
          permission: "channels:join",
          action: "allow",
          expiresAt: new Date("2033-01-01T00:00:00Z"),
        },
        {
          connectorRef: "slack",
          permission: "conversations.connect:read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "slack",
          permission: "conversations:history",
          action: "allow",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          connectorRef: "slack",
          permission: "conversations:read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "slack",
          permission: "conversations:write",
          action: "allow",
          expiresAt: new Date("2033-01-01T00:00:00Z"),
        },
        {
          connectorRef: "slack",
          permission: "conversations:write.invites",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "slack",
          permission: "conversations:write.topic",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "slack",
          permission: "search:read.public",
          action: "allow",
          expiresAt: new Date("2035-01-01T00:00:00Z"),
        },
        {
          connectorRef: "slack",
          permission: "team:read",
          action: "deny",
          expiresAt: new Date("2036-01-01T00:00:00Z"),
        },
      ]);
    });
  });
});
