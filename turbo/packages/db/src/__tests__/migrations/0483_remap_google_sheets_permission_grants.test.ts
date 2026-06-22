import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0483_remap_google_sheets_permission_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

const FULL_SHEETS_PERMISSIONS = [
  "developer-metadata.read",
  "developer-metadata.search",
  "sheets.copy",
  "spreadsheets.create",
  "spreadsheets.read",
  "spreadsheets.read-by-data-filter",
  "spreadsheets.write",
  "values.clear",
  "values.read",
  "values.read-by-data-filter",
  "values.write",
] as const;

const READONLY_SHEETS_ALLOW_PERMISSIONS = [
  "spreadsheets.read",
  "values.read",
] as const;

const READONLY_SHEETS_DENY_PERMISSIONS = [
  "developer-metadata.read",
  "developer-metadata.search",
  "spreadsheets.read",
  "spreadsheets.read-by-data-filter",
  "values.read",
  "values.read-by-data-filter",
] as const;

const OLD_ALLOW_REMAPS = {
  drive: FULL_SHEETS_PERMISSIONS,
  "drive.file": FULL_SHEETS_PERMISSIONS,
  "drive.readonly": READONLY_SHEETS_ALLOW_PERMISSIONS,
  spreadsheets: FULL_SHEETS_PERMISSIONS,
  "spreadsheets.readonly": READONLY_SHEETS_ALLOW_PERMISSIONS,
} as const satisfies Record<string, readonly string[]>;

const OLD_DENY_REMAPS = {
  drive: FULL_SHEETS_PERMISSIONS,
  "drive.file": FULL_SHEETS_PERMISSIONS,
  "drive.readonly": READONLY_SHEETS_DENY_PERMISSIONS,
  spreadsheets: FULL_SHEETS_PERMISSIONS,
  "spreadsheets.readonly": READONLY_SHEETS_DENY_PERMISSIONS,
} as const satisfies Record<string, readonly string[]>;

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

describe("migration 0483 remap Google Sheets permission grants", () => {
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
          connectorRef: "google-sheets",
          permission: "spreadsheets",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-sheets",
          permission: "spreadsheets.readonly",
          action: "deny",
          expiresAt: new Date("2031-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-sheets",
          permission: "values.write",
          action: "deny",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-sheets",
          permission: "__unknown__",
          action: "deny",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "spreadsheets",
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
          connectorRef: "google-sheets",
          permission: "__unknown__",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "google-sheets",
          permission: "developer-metadata.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "google-sheets",
          permission: "developer-metadata.search",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "google-sheets",
          permission: "sheets.copy",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          connectorRef: "google-sheets",
          permission: "spreadsheets.create",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          connectorRef: "google-sheets",
          permission: "spreadsheets.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "google-sheets",
          permission: "spreadsheets.read-by-data-filter",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "google-sheets",
          permission: "spreadsheets.write",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          connectorRef: "google-sheets",
          permission: "values.clear",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          connectorRef: "google-sheets",
          permission: "values.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "google-sheets",
          permission: "values.read-by-data-filter",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "google-sheets",
          permission: "values.write",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "slack",
          permission: "spreadsheets",
          action: "deny",
          expiresAt: new Date("2040-01-01T00:00:00Z"),
        },
      ]);
    });
  });

  it("preserves old Google Sheets allow grants by route overlap", async () => {
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
            connectorRef: "google-sheets",
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

  it("expands old Google Sheets deny grants conservatively", async () => {
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
            connectorRef: "google-sheets",
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
