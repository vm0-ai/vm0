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

interface SlackPermissionRemapCase {
  readonly oldPermission: string;
  readonly newPermissions: readonly string[];
  readonly retainOldPermission?: boolean;
}

type TransactionCallback = Parameters<typeof db.transaction>[0];
type Transaction = Parameters<TransactionCallback>[0];

class RollbackMigrationTestTransaction extends Error {}

const OLD_SLACK_PERMISSION_REMAPS: readonly SlackPermissionRemapCase[] = [
  {
    oldPermission: "channels:history",
    newPermissions: ["conversations:history"],
  },
  {
    oldPermission: "groups:history",
    newPermissions: ["conversations:history"],
  },
  {
    oldPermission: "im:history",
    newPermissions: ["conversations:history"],
  },
  {
    oldPermission: "mpim:history",
    newPermissions: ["conversations:history"],
  },
  { oldPermission: "channels:read", newPermissions: ["conversations:read"] },
  { oldPermission: "groups:read", newPermissions: ["conversations:read"] },
  { oldPermission: "im:read", newPermissions: ["conversations:read"] },
  { oldPermission: "mpim:read", newPermissions: ["conversations:read"] },
  {
    oldPermission: "channels:manage",
    newPermissions: [
      "conversations:write",
      "conversations:write.invites",
      "conversations:write.topic",
    ],
  },
  {
    oldPermission: "channels:write",
    newPermissions: [
      "channels:join",
      "conversations:write",
      "conversations:write.invites",
      "conversations:write.topic",
    ],
  },
  {
    oldPermission: "groups:write",
    newPermissions: [
      "conversations:write",
      "conversations:write.invites",
      "conversations:write.topic",
    ],
  },
  {
    oldPermission: "im:write",
    newPermissions: [
      "conversations:write",
      "conversations:write.invites",
      "conversations:write.topic",
    ],
  },
  {
    oldPermission: "mpim:write",
    newPermissions: [
      "conversations:write",
      "conversations:write.invites",
      "conversations:write.topic",
    ],
  },
  {
    oldPermission: "channels:write.invites",
    newPermissions: ["conversations:write.invites"],
  },
  {
    oldPermission: "groups:write.invites",
    newPermissions: ["conversations:write.invites"],
  },
  {
    oldPermission: "channels:write.topic",
    newPermissions: ["conversations:write.topic"],
  },
  {
    oldPermission: "groups:write.topic",
    newPermissions: ["conversations:write.topic"],
  },
  {
    oldPermission: "im:write.topic",
    newPermissions: ["conversations:write.topic"],
  },
  {
    oldPermission: "mpim:write.topic",
    newPermissions: ["conversations:write.topic"],
  },
  {
    oldPermission: "search:read.files",
    newPermissions: ["assistant.search:read"],
  },
  {
    oldPermission: "search:read.im",
    newPermissions: ["assistant.search:read"],
  },
  {
    oldPermission: "search:read.mpim",
    newPermissions: ["assistant.search:read"],
  },
  {
    oldPermission: "search:read.private",
    newPermissions: ["assistant.search:read"],
  },
  {
    oldPermission: "search:read.public",
    newPermissions: ["assistant.search:read"],
    retainOldPermission: true,
  },
  {
    oldPermission: "search:read.users",
    newPermissions: ["assistant.search:read"],
  },
  {
    oldPermission: "conversations.connect:manage",
    newPermissions: ["conversations.connect:read"],
    retainOldPermission: true,
  },
  {
    oldPermission: "team:read",
    newPermissions: ["conversations.connect:read"],
    retainOldPermission: true,
  },
];

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

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    return left.localeCompare(right);
  });
}

describe("migration 0492 remap Slack permission grants", () => {
  it("expands every old Slack route owner grant to the new route-owning permissions", async () => {
    await runInRollbackTransaction(async (tx) => {
      const seededCases: Array<
        SlackPermissionRemapCase & { readonly orgId: string }
      > = [];
      const expiresAt = new Date("2030-01-01T00:00:00Z");

      for (const [index, remap] of OLD_SLACK_PERMISSION_REMAPS.entries()) {
        const orgId = uniqueId(`org-${index}`);
        const ownerId = uniqueId(`owner-${index}`);
        const userId = uniqueId(`user-${index}`);
        const agentId = await createAgent(tx, orgId, ownerId);

        await tx.insert(userPermissionGrants).values({
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: remap.oldPermission,
          action: "allow",
          expiresAt,
        });

        seededCases.push({ ...remap, orgId });
      }

      await tx.execute(sql.raw(migrationSql));

      for (const remap of seededCases) {
        const grants = await tx
          .select({
            permission: userPermissionGrants.permission,
            action: userPermissionGrants.action,
            expiresAt: userPermissionGrants.expiresAt,
          })
          .from(userPermissionGrants)
          .where(eq(userPermissionGrants.orgId, remap.orgId))
          .orderBy(asc(userPermissionGrants.permission));
        const expectedPermissions = sortedUnique([
          ...remap.newPermissions,
          ...(remap.retainOldPermission ? [remap.oldPermission] : []),
        ]);

        expect({ oldPermission: remap.oldPermission, grants }).toStrictEqual({
          oldPermission: remap.oldPermission,
          grants: expectedPermissions.map((permission) => {
            return {
              permission,
              action: "allow",
              expiresAt,
            };
          }),
        });
      }
    });
  });

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
