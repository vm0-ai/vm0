import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0476_remap_google_drive_permission_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

const OLD_GOOGLE_DRIVE_PERMISSIONS = [
  "drive",
  "drive.appdata",
  "drive.apps.readonly",
  "drive.file",
  "drive.install",
  "drive.meet.readonly",
  "drive.metadata",
  "drive.metadata.readonly",
  "drive.photos.readonly",
  "drive.readonly",
  "drive.scripts",
];

const NEW_GOOGLE_DRIVE_PERMISSIONS = [
  "about.read",
  "apps.read",
  "changes.read",
  "channels.write",
  "comments.read",
  "comments.write",
  "drives.delete",
  "drives.read",
  "drives.write",
  "files.delete",
  "files.read",
  "files.share",
  "files.write",
  "operations.read",
  "replies.read",
  "replies.write",
  "revisions.delete",
  "revisions.read",
  "revisions.write",
];

const DRIVE_READONLY_DENIED_PERMISSIONS = [
  "about.read",
  "apps.read",
  "changes.read",
  "channels.write",
  "comments.read",
  "drives.read",
  "files.read",
  "files.share",
  "operations.read",
  "replies.read",
  "revisions.read",
];

const OLD_DENY_PERMISSION_EXPECTATIONS = [
  {
    oldPermission: "drive",
    permissions: NEW_GOOGLE_DRIVE_PERMISSIONS,
  },
  {
    oldPermission: "drive.appdata",
    permissions: [
      "about.read",
      "apps.read",
      "changes.read",
      "channels.write",
      "files.delete",
      "files.read",
      "files.share",
      "files.write",
      "revisions.delete",
      "revisions.read",
      "revisions.write",
    ],
  },
  {
    oldPermission: "drive.apps.readonly",
    permissions: ["apps.read"],
  },
  {
    oldPermission: "drive.file",
    permissions: [
      "about.read",
      "apps.read",
      "changes.read",
      "channels.write",
      "comments.read",
      "comments.write",
      "files.delete",
      "files.read",
      "files.share",
      "files.write",
      "operations.read",
      "replies.read",
      "replies.write",
      "revisions.delete",
      "revisions.read",
      "revisions.write",
    ],
  },
  {
    oldPermission: "drive.install",
    permissions: [],
  },
  {
    oldPermission: "drive.meet.readonly",
    permissions: [
      "changes.read",
      "channels.write",
      "comments.read",
      "files.read",
      "files.share",
      "operations.read",
      "replies.read",
      "revisions.read",
    ],
  },
  {
    oldPermission: "drive.metadata",
    permissions: [
      "about.read",
      "apps.read",
      "changes.read",
      "channels.write",
      "files.read",
      "files.share",
      "files.write",
      "revisions.read",
    ],
  },
  {
    oldPermission: "drive.metadata.readonly",
    permissions: [
      "about.read",
      "apps.read",
      "changes.read",
      "channels.write",
      "files.read",
      "files.share",
      "revisions.read",
    ],
  },
  {
    oldPermission: "drive.photos.readonly",
    permissions: [
      "about.read",
      "changes.read",
      "channels.write",
      "files.read",
      "files.share",
      "files.write",
      "revisions.read",
    ],
  },
  {
    oldPermission: "drive.readonly",
    permissions: DRIVE_READONLY_DENIED_PERMISSIONS,
  },
  {
    oldPermission: "drive.scripts",
    permissions: ["files.write"],
  },
] as const;

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

describe("migration 0476 remap Google Drive permission grants", () => {
  it("remaps old Google Drive grants without over-granting broad scopes", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const appsUserId = uniqueId("apps-user");
      const existingDenyUserId = uniqueId("existing-deny-user");
      const existingAllowUserId = uniqueId("existing-allow-user");
      const broadAllowUserId = uniqueId("allow-user");
      const readonlyDenyUserId = uniqueId("readonly-deny-user");
      const fullDenyUserId = uniqueId("full-deny-user");
      const scriptsDenyUserId = uniqueId("scripts-deny-user");
      const installDenyUserId = uniqueId("install-deny-user");
      const expiresAt = new Date("2030-01-01T00:00:00Z");

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
          userId: appsUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "drive.apps.readonly",
          action: "allow",
          expiresAt,
        },
        {
          orgId,
          userId: existingDenyUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "drive.apps.readonly",
          action: "allow",
          expiresAt,
        },
        {
          orgId,
          userId: existingDenyUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "apps.read",
          action: "deny",
        },
        {
          orgId,
          userId: existingAllowUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "drive.apps.readonly",
          action: "allow",
          expiresAt,
        },
        {
          orgId,
          userId: existingAllowUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "apps.read",
          action: "allow",
        },
        {
          orgId,
          userId: broadAllowUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "drive.file",
          action: "allow",
        },
        {
          orgId,
          userId: readonlyDenyUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "drive.readonly",
          action: "deny",
        },
        {
          orgId,
          userId: readonlyDenyUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "files.read",
          action: "allow",
        },
        {
          orgId,
          userId: fullDenyUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "drive",
          action: "deny",
        },
        {
          orgId,
          userId: scriptsDenyUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "drive.scripts",
          action: "deny",
        },
        {
          orgId,
          userId: installDenyUserId,
          agentId,
          connectorRef: "google-drive",
          permission: "drive.install",
          action: "deny",
        },
        {
          orgId,
          userId: broadAllowUserId,
          agentId,
          connectorRef: "google-docs",
          permission: "drive.file",
          action: "allow",
        },
      ]);

      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql.raw(migrationSql));

      const [oldGoogleDriveGrantCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.connectorRef, "google-drive"),
            inArray(
              userPermissionGrants.permission,
              OLD_GOOGLE_DRIVE_PERMISSIONS,
            ),
          ),
        );
      expect(oldGoogleDriveGrantCount!.count).toBe(0);

      const appsGrants = await tx
        .select({
          permission: userPermissionGrants.permission,
          action: userPermissionGrants.action,
          expiresAt: userPermissionGrants.expiresAt,
        })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.userId, appsUserId),
            eq(userPermissionGrants.connectorRef, "google-drive"),
          ),
        );
      expect(appsGrants).toStrictEqual([
        {
          permission: "apps.read",
          action: "allow",
          expiresAt,
        },
      ]);

      const existingDenyGrants = await tx
        .select({
          permission: userPermissionGrants.permission,
          action: userPermissionGrants.action,
          expiresAt: userPermissionGrants.expiresAt,
        })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.userId, existingDenyUserId),
            eq(userPermissionGrants.connectorRef, "google-drive"),
          ),
        );
      expect(existingDenyGrants).toStrictEqual([
        {
          permission: "apps.read",
          action: "deny",
          expiresAt: null,
        },
      ]);

      const existingAllowGrants = await tx
        .select({
          permission: userPermissionGrants.permission,
          action: userPermissionGrants.action,
          expiresAt: userPermissionGrants.expiresAt,
        })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.userId, existingAllowUserId),
            eq(userPermissionGrants.connectorRef, "google-drive"),
          ),
        );
      expect(existingAllowGrants).toStrictEqual([
        {
          permission: "apps.read",
          action: "allow",
          expiresAt: null,
        },
      ]);

      const broadAllowGoogleDriveGrants = await tx
        .select({ id: userPermissionGrants.id })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.userId, broadAllowUserId),
            eq(userPermissionGrants.connectorRef, "google-drive"),
          ),
        );
      expect(broadAllowGoogleDriveGrants).toStrictEqual([]);

      const readonlyDenyGrants = await tx
        .select({
          permission: userPermissionGrants.permission,
          action: userPermissionGrants.action,
          expiresAt: userPermissionGrants.expiresAt,
        })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.userId, readonlyDenyUserId),
            eq(userPermissionGrants.connectorRef, "google-drive"),
          ),
        )
        .orderBy(asc(userPermissionGrants.permission));
      expect(readonlyDenyGrants).toStrictEqual(
        DRIVE_READONLY_DENIED_PERMISSIONS.map((permission) => {
          return {
            permission,
            action: "deny",
            expiresAt: null,
          };
        }),
      );

      const fullDenyGrants = await tx
        .select({
          permission: userPermissionGrants.permission,
          action: userPermissionGrants.action,
          expiresAt: userPermissionGrants.expiresAt,
        })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.userId, fullDenyUserId),
            eq(userPermissionGrants.connectorRef, "google-drive"),
          ),
        )
        .orderBy(asc(userPermissionGrants.permission));
      expect(fullDenyGrants).toStrictEqual(
        NEW_GOOGLE_DRIVE_PERMISSIONS.map((permission) => {
          return {
            permission,
            action: "deny",
            expiresAt: null,
          };
        }),
      );

      const scriptsDenyGrants = await tx
        .select({
          permission: userPermissionGrants.permission,
          action: userPermissionGrants.action,
        })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.userId, scriptsDenyUserId),
            eq(userPermissionGrants.connectorRef, "google-drive"),
          ),
        );
      expect(scriptsDenyGrants).toStrictEqual([
        {
          permission: "files.write",
          action: "deny",
        },
      ]);

      const installDenyGrants = await tx
        .select({ id: userPermissionGrants.id })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.userId, installDenyUserId),
            eq(userPermissionGrants.connectorRef, "google-drive"),
          ),
        );
      expect(installDenyGrants).toStrictEqual([]);

      const googleDocsGrants = await tx
        .select({
          permission: userPermissionGrants.permission,
          action: userPermissionGrants.action,
        })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.userId, broadAllowUserId),
            eq(userPermissionGrants.connectorRef, "google-docs"),
          ),
        );
      expect(googleDocsGrants).toStrictEqual([
        {
          permission: "drive.file",
          action: "allow",
        },
      ]);
    });
  });

  it("maps every old Google Drive deny permission through the route-overlap table", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const usersByOldPermission = new Map<string, string>();

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

      await tx.insert(userPermissionGrants).values(
        OLD_DENY_PERMISSION_EXPECTATIONS.map(({ oldPermission }) => {
          const userId = uniqueId("deny-user");
          usersByOldPermission.set(oldPermission, userId);
          return {
            orgId,
            userId,
            agentId,
            connectorRef: "google-drive",
            permission: oldPermission,
            action: "deny" as const,
          };
        }),
      );

      await tx.execute(sql.raw(migrationSql));

      for (const expectation of OLD_DENY_PERMISSION_EXPECTATIONS) {
        const userId = usersByOldPermission.get(expectation.oldPermission);
        if (!userId) {
          throw new Error(
            `Missing test user for old permission: ${expectation.oldPermission}`,
          );
        }

        const grants = await tx
          .select({
            permission: userPermissionGrants.permission,
            action: userPermissionGrants.action,
            expiresAt: userPermissionGrants.expiresAt,
          })
          .from(userPermissionGrants)
          .where(
            and(
              eq(userPermissionGrants.orgId, orgId),
              eq(userPermissionGrants.userId, userId),
              eq(userPermissionGrants.connectorRef, "google-drive"),
            ),
          )
          .orderBy(asc(userPermissionGrants.permission));

        expect(grants, expectation.oldPermission).toStrictEqual(
          expectation.permissions.map((permission) => {
            return {
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
