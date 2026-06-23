import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0493_remap_strava_permission_grants.sql",
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

interface StravaPermissionRemapCase {
  readonly oldPermission: string;
  readonly newPermissions: readonly string[];
  readonly retainOldPermission?: boolean;
}

type TransactionCallback = Parameters<typeof db.transaction>[0];
type Transaction = Parameters<TransactionCallback>[0];

class RollbackMigrationTestTransaction extends Error {}

const STRAVA_PERMISSION_REMAPS: readonly StravaPermissionRemapCase[] = [
  {
    oldPermission: "activity:read",
    newPermissions: ["activities:read"],
  },
  {
    oldPermission: "activity:read_all",
    newPermissions: ["activities:read"],
  },
  {
    oldPermission: "activity:write",
    newPermissions: ["activities:write", "uploads:write"],
  },
  {
    oldPermission: "read",
    newPermissions: [
      "athlete_stats:read",
      "clubs:read",
      "gear:read",
      "profile:read",
      "routes:read",
      "segment_efforts:read",
      "segments:read",
    ],
  },
  {
    oldPermission: "profile:read_all",
    newPermissions: ["profile:read"],
  },
  {
    oldPermission: "profile:write",
    newPermissions: ["segments:write"],
    retainOldPermission: true,
  },
  {
    oldPermission: "read_all",
    newPermissions: [
      "routes:read",
      "segment_effort_streams:read",
      "segments:read",
    ],
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

describe("migration 0493 remap Strava permission grants", () => {
  it("expands every old Strava scope grant to the matching resource permissions", async () => {
    await runInRollbackTransaction(async (tx) => {
      const seededCases: Array<
        StravaPermissionRemapCase & { readonly orgId: string }
      > = [];
      const expiresAt = new Date("2030-01-01T00:00:00Z");

      for (const [index, remap] of STRAVA_PERMISSION_REMAPS.entries()) {
        const orgId = uniqueId(`org-${index}`);
        const ownerId = uniqueId(`owner-${index}`);
        const userId = uniqueId(`user-${index}`);
        const agentId = await createAgent(tx, orgId, ownerId);

        await tx.insert(userPermissionGrants).values({
          orgId,
          userId,
          agentId,
          connectorRef: "strava",
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
          connectorRef: "strava",
          permission: "activity:read",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "strava",
          permission: "activity:read_all",
          action: "deny",
          expiresAt: new Date("2031-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "strava",
          permission: "read",
          action: "allow",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "strava",
          permission: "activity:write",
          action: "allow",
          expiresAt: new Date("2037-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "strava",
          permission: "profile:read_all",
          action: "deny",
          expiresAt: new Date("2033-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "strava",
          permission: "read_all",
          action: "allow",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "strava",
          permission: "profile:write",
          action: "allow",
          expiresAt: new Date("2035-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "strava",
          permission: "routes:read",
          action: "allow",
          expiresAt: new Date("2034-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "activity:read",
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
          permission: "activity:read",
          action: "allow",
          expiresAt: new Date("2040-01-01T00:00:00Z"),
        },
        {
          connectorRef: "strava",
          permission: "activities:read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "strava",
          permission: "activities:write",
          action: "allow",
          expiresAt: new Date("2037-01-01T00:00:00Z"),
        },
        {
          connectorRef: "strava",
          permission: "athlete_stats:read",
          action: "allow",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          connectorRef: "strava",
          permission: "clubs:read",
          action: "allow",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          connectorRef: "strava",
          permission: "gear:read",
          action: "allow",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          connectorRef: "strava",
          permission: "profile:read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "strava",
          permission: "profile:write",
          action: "allow",
          expiresAt: new Date("2035-01-01T00:00:00Z"),
        },
        {
          connectorRef: "strava",
          permission: "routes:read",
          action: "allow",
          expiresAt: null,
        },
        {
          connectorRef: "strava",
          permission: "segment_effort_streams:read",
          action: "allow",
          expiresAt: null,
        },
        {
          connectorRef: "strava",
          permission: "segment_efforts:read",
          action: "allow",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          connectorRef: "strava",
          permission: "segments:read",
          action: "allow",
          expiresAt: null,
        },
        {
          connectorRef: "strava",
          permission: "segments:write",
          action: "allow",
          expiresAt: new Date("2035-01-01T00:00:00Z"),
        },
        {
          connectorRef: "strava",
          permission: "uploads:write",
          action: "allow",
          expiresAt: new Date("2037-01-01T00:00:00Z"),
        },
      ]);
    });
  });
});
