import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0477_remap_gmail_permission_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

const OLD_DENY_REMAPS = {
  gmail: [
    "drafts.read",
    "drafts.send",
    "drafts.write",
    "history.read",
    "labels.read",
    "labels.write",
    "messages.delete",
    "messages.read",
    "messages.send",
    "messages.write",
    "notifications.write",
    "profile.read",
    "settings.read",
    "threads.delete",
    "threads.read",
    "threads.write",
  ],
  "gmail.addons.current.action.compose": [
    "drafts.send",
    "drafts.write",
    "messages.send",
  ],
  "gmail.addons.current.message.action": ["messages.read", "threads.read"],
  "gmail.addons.current.message.metadata": ["messages.read", "threads.read"],
  "gmail.addons.current.message.readonly": ["messages.read", "threads.read"],
  "gmail.compose": ["drafts.read", "drafts.write", "profile.read"],
  "gmail.insert": ["messages.write"],
  "gmail.labels": ["labels.read", "labels.write"],
  "gmail.metadata": [
    "history.read",
    "labels.read",
    "messages.read",
    "notifications.write",
    "profile.read",
    "threads.read",
  ],
  "gmail.modify": [
    "drafts.read",
    "drafts.send",
    "drafts.write",
    "history.read",
    "labels.read",
    "labels.write",
    "messages.read",
    "messages.send",
    "messages.write",
    "notifications.write",
    "profile.read",
    "settings.read",
    "threads.read",
    "threads.write",
  ],
  "gmail.readonly": [
    "drafts.read",
    "history.read",
    "labels.read",
    "messages.read",
    "notifications.write",
    "profile.read",
    "settings.read",
    "threads.read",
  ],
  "gmail.send": ["drafts.send", "messages.send"],
  "gmail.settings.basic": ["settings.read", "settings.write"],
  "gmail.settings.sharing": [
    "settings.read",
    "settings.sharing",
    "settings.write",
  ],
} as const satisfies Record<string, readonly string[]>;

interface GrantRow {
  readonly connectorRef: string;
  readonly permission: string;
  readonly action: "allow" | "deny";
  readonly expiresAt: Date | null;
}

class RollbackMigrationTestTransaction extends Error {}

async function runInRollbackTransaction(
  callback: Parameters<typeof db.transaction>[0],
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

describe("migration 0477 remap Gmail permission grants", () => {
  it("remaps Gmail grants, resolves conflicts, deletes old names, and is idempotent", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const userId = uniqueId("user");

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

      await tx.insert(userPermissionGrants).values([
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "gmail.send",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "gmail.addons.current.action.compose",
          action: "allow",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "gmail.insert",
          action: "allow",
          expiresAt: new Date("2029-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "gmail.labels",
          action: "allow",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "gmail.modify",
          action: "allow",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "gmail.readonly",
          action: "deny",
          expiresAt: new Date("2031-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "gmail.settings.basic",
          action: "allow",
          expiresAt: new Date("2028-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "gmail.settings.sharing",
          action: "deny",
          expiresAt: new Date("2028-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "drafts.send",
          action: "allow",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "messages.send",
          action: "deny",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "gmail.send",
          action: "deny",
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
          permission: "drafts.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "drafts.send",
          action: "allow",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "drafts.write",
          action: "allow",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          connectorRef: "gmail",
          permission: "history.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "labels.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "labels.write",
          action: "allow",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "messages.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "messages.send",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "messages.write",
          action: "allow",
          expiresAt: new Date("2029-01-01T00:00:00Z"),
        },
        {
          connectorRef: "gmail",
          permission: "notifications.write",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "profile.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "settings.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "settings.sharing",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "settings.write",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "gmail",
          permission: "threads.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "slack",
          permission: "gmail.send",
          action: "deny",
          expiresAt: new Date("2040-01-01T00:00:00Z"),
        },
      ]);
    });
  });

  it("expands every old Gmail deny grant to the route-overlapping new permissions", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");

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

      const usersByOldPermission = new Map<string, string>();
      await tx.insert(userPermissionGrants).values(
        Object.keys(OLD_DENY_REMAPS).map((permission) => {
          const userId = uniqueId("user");
          usersByOldPermission.set(permission, userId);
          return {
            orgId,
            userId,
            agentId,
            connectorRef: "gmail",
            permission,
            action: "deny" as const,
            expiresAt: new Date("2035-01-01T00:00:00Z"),
          };
        }),
      );

      await tx.execute(sql.raw(migrationSql));

      const grants = await tx
        .select({
          userId: userPermissionGrants.userId,
          permission: userPermissionGrants.permission,
          action: userPermissionGrants.action,
          expiresAt: userPermissionGrants.expiresAt,
        })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.orgId, orgId))
        .orderBy(
          asc(userPermissionGrants.userId),
          asc(userPermissionGrants.permission),
        );

      const grantsByUser = new Map<string, typeof grants>();
      for (const grant of grants) {
        const rows = grantsByUser.get(grant.userId) ?? [];
        rows.push(grant);
        grantsByUser.set(grant.userId, rows);
      }

      for (const [oldPermission, expectedNewPermissions] of Object.entries(
        OLD_DENY_REMAPS,
      )) {
        const userId = usersByOldPermission.get(oldPermission)!;
        expect(grantsByUser.get(userId)).toStrictEqual(
          expectedNewPermissions.map((permission) => {
            return {
              userId,
              permission,
              action: "deny",
              expiresAt: null,
            };
          }),
        );
      }
    });
  });
});
