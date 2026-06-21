import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0479_remap_google_calendar_permission_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

const OLD_DENY_REMAPS = {
  calendar: [
    "acl.delete",
    "acl.read",
    "acl.write",
    "calendar-list.delete",
    "calendar-list.read",
    "calendar-list.write",
    "calendars.clear",
    "calendars.delete",
    "calendars.read",
    "calendars.write",
    "colors.read",
    "events.delete",
    "events.read",
    "events.write",
    "freebusy.query",
    "notifications.write",
    "settings.read",
  ],
  "calendar.acls": [
    "acl.delete",
    "acl.read",
    "acl.write",
    "notifications.write",
  ],
  "calendar.acls.readonly": ["acl.read", "notifications.write"],
  "calendar.app.created": [
    "calendar-list.delete",
    "calendar-list.read",
    "calendar-list.write",
    "calendars.delete",
    "calendars.read",
    "calendars.write",
    "colors.read",
    "events.delete",
    "events.read",
    "events.write",
    "notifications.write",
  ],
  "calendar.calendarlist": [
    "calendar-list.delete",
    "calendar-list.read",
    "calendar-list.write",
    "colors.read",
    "notifications.write",
  ],
  "calendar.calendarlist.readonly": [
    "calendar-list.read",
    "colors.read",
    "notifications.write",
  ],
  "calendar.calendars": [
    "calendars.clear",
    "calendars.delete",
    "calendars.read",
    "calendars.write",
  ],
  "calendar.calendars.readonly": ["calendars.read"],
  "calendar.events": [
    "events.delete",
    "events.read",
    "events.write",
    "notifications.write",
  ],
  "calendar.events.freebusy": [
    "colors.read",
    "events.read",
    "freebusy.query",
    "notifications.write",
  ],
  "calendar.events.owned": [
    "colors.read",
    "events.delete",
    "events.read",
    "events.write",
    "notifications.write",
  ],
  "calendar.events.owned.readonly": [
    "colors.read",
    "events.read",
    "notifications.write",
  ],
  "calendar.events.public.readonly": [
    "colors.read",
    "events.read",
    "notifications.write",
  ],
  "calendar.events.readonly": ["events.read", "notifications.write"],
  "calendar.freebusy": ["freebusy.query"],
  "calendar.readonly": [
    "acl.read",
    "calendar-list.read",
    "calendars.read",
    "colors.read",
    "events.read",
    "freebusy.query",
    "notifications.write",
    "settings.read",
  ],
  "calendar.settings.readonly": ["notifications.write", "settings.read"],
} as const satisfies Record<string, readonly string[]>;

const PRESERVED_OLD_ALLOW_REMAPS = {
  "calendar.acls": ["acl.delete", "acl.read", "acl.write"],
  "calendar.acls.readonly": ["acl.read"],
  "calendar.calendarlist": [
    "calendar-list.delete",
    "calendar-list.read",
    "calendar-list.write",
    "colors.read",
  ],
  "calendar.calendarlist.readonly": ["calendar-list.read", "colors.read"],
  "calendar.calendars": [
    "calendars.clear",
    "calendars.delete",
    "calendars.read",
    "calendars.write",
  ],
  "calendar.calendars.readonly": ["calendars.read"],
  "calendar.events": ["events.delete", "events.read", "events.write"],
  "calendar.events.freebusy": ["colors.read", "freebusy.query"],
  "calendar.events.readonly": ["events.read"],
  "calendar.freebusy": ["freebusy.query"],
  "calendar.readonly": [
    "calendar-list.read",
    "calendars.read",
    "colors.read",
    "events.read",
    "freebusy.query",
    "settings.read",
  ],
  "calendar.settings.readonly": ["settings.read"],
} as const satisfies Record<string, readonly string[]>;

const DROPPED_OLD_ALLOW_PERMISSIONS = [
  "calendar",
  "calendar.app.created",
  "calendar.events.owned",
  "calendar.events.owned.readonly",
  "calendar.events.public.readonly",
] as const;

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

describe("migration 0479 remap Google Calendar permission grants", () => {
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
          connectorRef: "google-calendar",
          permission: "calendar.events",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-calendar",
          permission: "calendar.events.readonly",
          action: "deny",
          expiresAt: new Date("2031-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-calendar",
          permission: "calendar.calendarlist",
          action: "allow",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-calendar",
          permission: "calendar",
          action: "allow",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "google-calendar",
          permission: "events.write",
          action: "deny",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "calendar.events",
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
          connectorRef: "google-calendar",
          permission: "calendar-list.delete",
          action: "allow",
          expiresAt: null,
        },
        {
          connectorRef: "google-calendar",
          permission: "calendar-list.read",
          action: "allow",
          expiresAt: null,
        },
        {
          connectorRef: "google-calendar",
          permission: "calendar-list.write",
          action: "allow",
          expiresAt: null,
        },
        {
          connectorRef: "google-calendar",
          permission: "colors.read",
          action: "allow",
          expiresAt: null,
        },
        {
          connectorRef: "google-calendar",
          permission: "events.delete",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          connectorRef: "google-calendar",
          permission: "events.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "google-calendar",
          permission: "events.write",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "google-calendar",
          permission: "notifications.write",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "slack",
          permission: "calendar.events",
          action: "deny",
          expiresAt: new Date("2040-01-01T00:00:00Z"),
        },
      ]);
    });
  });

  it("preserves non-expanding narrow Google Calendar allow grants", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const agentId = await createAgent(tx, orgId, ownerId);

      const usersByOldPermission = new Map<string, string>();
      await tx.insert(userPermissionGrants).values(
        Object.keys(PRESERVED_OLD_ALLOW_REMAPS).map((permission) => {
          const userId = uniqueId("user");
          usersByOldPermission.set(permission, userId);
          return {
            orgId,
            userId,
            agentId,
            connectorRef: "google-calendar",
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
        PRESERVED_OLD_ALLOW_REMAPS,
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

  it("drops old Google Calendar allow grants that are not safely preservable", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const agentId = await createAgent(tx, orgId, ownerId);

      await tx.insert(userPermissionGrants).values(
        DROPPED_OLD_ALLOW_PERMISSIONS.map((permission) => {
          return {
            orgId,
            userId: uniqueId("user"),
            agentId,
            connectorRef: "google-calendar",
            permission,
            action: "allow" as const,
            expiresAt: new Date("2035-01-01T00:00:00Z"),
          };
        }),
      );

      await tx.execute(sql.raw(migrationSql));

      const grants = await tx
        .select({ permission: userPermissionGrants.permission })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.orgId, orgId));

      expect(grants).toStrictEqual([]);
    });
  });

  it("expands every old Google Calendar deny grant to route-overlapping new permissions", async () => {
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
            connectorRef: "google-calendar",
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
