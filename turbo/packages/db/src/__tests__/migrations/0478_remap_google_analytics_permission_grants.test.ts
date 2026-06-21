import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0478_remap_google_analytics_permission_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

const OLD_ALLOW_REMAPS = {
  analytics: [
    "audience-exports.read",
    "audience-exports.run",
    "metadata.read",
    "reports.run",
  ],
  "analytics.edit": [
    "access-reports.run",
    "accounts.delete",
    "accounts.read",
    "accounts.write",
    "change-history.read",
    "custom-definitions.read",
    "custom-definitions.write",
    "data-streams.delete",
    "data-streams.read",
    "data-streams.write",
    "key-events.delete",
    "key-events.read",
    "key-events.write",
    "links.delete",
    "links.read",
    "links.write",
    "measurement-secrets.delete",
    "measurement-secrets.read",
    "measurement-secrets.write",
    "properties.delete",
    "properties.read",
    "properties.write",
  ],
  "analytics.readonly": [
    "access-reports.run",
    "accounts.read",
    "audience-exports.read",
    "audience-exports.run",
    "custom-definitions.read",
    "data-streams.read",
    "key-events.read",
    "links.read",
    "measurement-secrets.read",
    "metadata.read",
    "properties.read",
    "reports.run",
  ],
} as const satisfies Record<string, readonly string[]>;

const OLD_DENY_REMAPS = OLD_ALLOW_REMAPS;

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

function groupGrantsByUser<T extends { readonly userId: string }>(
  grants: readonly T[],
): Map<string, T[]> {
  const grantsByUser = new Map<string, T[]>();
  for (const grant of grants) {
    const rows = grantsByUser.get(grant.userId) ?? [];
    rows.push(grant);
    grantsByUser.set(grant.userId, rows);
  }
  return grantsByUser;
}

describe("migration 0478 remap Google Analytics permission grants", () => {
  it("remaps grants, resolves conflicts, deletes old names, and is idempotent", async () => {
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
          connectorRef: "google-analytics",
          permission: "analytics",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-analytics",
          permission: "analytics.readonly",
          action: "deny",
          expiresAt: new Date("2031-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-analytics",
          permission: "analytics.edit",
          action: "allow",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-analytics",
          permission: "reports.run",
          action: "deny",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-analytics",
          permission: "accounts.read",
          action: "allow",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "analytics.edit",
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

      expect(
        grants.filter((grant) => {
          return (
            grant.connectorRef === "google-analytics" &&
            ["analytics", "analytics.edit", "analytics.readonly"].includes(
              grant.permission,
            )
          );
        }),
      ).toStrictEqual([]);
      expect(grants).toHaveLength(27);
      expect(
        grants.find((grant) => {
          return (
            grant.connectorRef === "google-analytics" &&
            grant.permission === "reports.run"
          );
        }),
      ).toStrictEqual({
        connectorRef: "google-analytics",
        permission: "reports.run",
        action: "deny",
        expiresAt: null,
      });
      expect(
        grants.find((grant) => {
          return (
            grant.connectorRef === "google-analytics" &&
            grant.permission === "accounts.write"
          );
        }),
      ).toStrictEqual({
        connectorRef: "google-analytics",
        permission: "accounts.write",
        action: "allow",
        expiresAt: new Date("2032-01-01T00:00:00Z"),
      });
      expect(
        grants.find((grant) => {
          return (
            grant.connectorRef === "google-analytics" &&
            grant.permission === "measurement-secrets.read"
          );
        }),
      ).toStrictEqual({
        connectorRef: "google-analytics",
        permission: "measurement-secrets.read",
        action: "deny",
        expiresAt: null,
      });
      expect(
        grants.find((grant) => {
          return grant.connectorRef === "slack";
        }),
      ).toStrictEqual({
        connectorRef: "slack",
        permission: "analytics.edit",
        action: "deny",
        expiresAt: new Date("2040-01-01T00:00:00Z"),
      });
    });
  });

  it("preserves every non-expanding old Google Analytics allow grant", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const agentId = await createAgent(tx, orgId, ownerId);

      const usersByOldPermission = new Map<string, string>();
      await tx.insert(userPermissionGrants).values(
        Object.keys(OLD_ALLOW_REMAPS).map((permission) => {
          const userId = uniqueId("user");
          usersByOldPermission.set(permission, userId);
          return {
            orgId,
            userId,
            agentId,
            connectorRef: "google-analytics",
            permission,
            action: "allow" as const,
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

      const grantsByUser = groupGrantsByUser(grants);
      for (const [oldPermission, expectedNewPermissions] of Object.entries(
        OLD_ALLOW_REMAPS,
      )) {
        const userId = usersByOldPermission.get(oldPermission)!;
        expect(grantsByUser.get(userId)).toStrictEqual(
          expectedNewPermissions.map((permission) => {
            return {
              userId,
              permission,
              action: "allow",
              expiresAt: new Date("2035-01-01T00:00:00Z"),
            };
          }),
        );
      }
    });
  });

  it("expands every old Google Analytics deny grant to route-overlapping new permissions", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const agentId = await createAgent(tx, orgId, ownerId);

      const usersByOldPermission = new Map<string, string>();
      await tx.insert(userPermissionGrants).values(
        Object.keys(OLD_DENY_REMAPS).map((permission) => {
          const userId = uniqueId("user");
          usersByOldPermission.set(permission, userId);
          return {
            orgId,
            userId,
            agentId,
            connectorRef: "google-analytics",
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

      const grantsByUser = groupGrantsByUser(grants);
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
