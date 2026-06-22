import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0485_remap_youtube_permission_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

const YOUTUBE_SCOPE_PERMISSIONS = [
  "abuse-reports.create",
  "activities.read",
  "channel-banners.upload",
  "channel-sections.delete",
  "channel-sections.read",
  "channel-sections.write",
  "channels.read",
  "channels.write",
  "i18n-languages.read",
  "i18n-regions.read",
  "live-broadcasts.control",
  "live-broadcasts.create",
  "live-broadcasts.delete",
  "live-broadcasts.read",
  "live-broadcasts.write",
  "live-chat-bans.write",
  "live-chat-messages.delete",
  "live-chat-messages.read",
  "live-chat-messages.write",
  "live-chat-moderators.read",
  "live-chat-moderators.write",
  "live-streams.create",
  "live-streams.delete",
  "live-streams.read",
  "live-streams.write",
  "playlist-images.delete",
  "playlist-images.read",
  "playlist-images.write",
  "playlist-items.delete",
  "playlist-items.read",
  "playlist-items.write",
  "playlists.delete",
  "playlists.read",
  "playlists.write",
  "search.read",
  "subscriptions.delete",
  "subscriptions.read",
  "subscriptions.write",
  "super-chat-events.read",
  "thumbnails.set",
  "video-abuse-report-reasons.read",
  "video-categories.read",
  "video-trainability.read",
  "videos.create",
  "videos.delete",
  "videos.rate",
  "videos.rating.read",
  "videos.read",
  "videos.report-abuse",
  "videos.write",
  "watermarks.delete",
  "watermarks.set",
] as const;

const FORCE_SSL_EXTRA_PERMISSIONS = [
  "captions.delete",
  "captions.download",
  "captions.read",
  "captions.write",
  "comment-threads.read",
  "comment-threads.write",
  "comments.delete",
  "comments.moderate",
  "comments.read",
  "comments.write",
] as const;

const READONLY_PERMISSIONS = [
  "activities.read",
  "channel-sections.read",
  "channels.read",
  "i18n-languages.read",
  "i18n-regions.read",
  "live-broadcasts.read",
  "live-chat-messages.read",
  "live-chat-moderators.read",
  "live-streams.read",
  "playlist-images.read",
  "playlist-items.read",
  "playlists.read",
  "search.read",
  "subscriptions.read",
  "super-chat-events.read",
  "tests.create",
  "video-abuse-report-reasons.read",
  "video-categories.read",
  "video-trainability.read",
  "videos.read",
] as const;

const UPLOAD_PERMISSIONS = [
  "channel-banners.upload",
  "thumbnails.set",
  "videos.create",
  "watermarks.set",
] as const;

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => {
    return left.localeCompare(right);
  });
}

const FORCE_SSL_PERMISSIONS = sortedUnique([
  ...YOUTUBE_SCOPE_PERMISSIONS,
  ...FORCE_SSL_EXTRA_PERMISSIONS,
]);

const OLD_PERMISSION_REMAPS = {
  youtube: YOUTUBE_SCOPE_PERMISSIONS,
  "youtube.force-ssl": FORCE_SSL_PERMISSIONS,
  "youtube.readonly": READONLY_PERMISSIONS,
  "youtube.upload": UPLOAD_PERMISSIONS,
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

describe("migration 0485 remap YouTube permission grants", () => {
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
          connectorRef: "youtube",
          permission: "youtube",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "youtube",
          permission: "youtube.readonly",
          action: "deny",
          expiresAt: new Date("2031-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "youtube",
          permission: "videos.create",
          action: "deny",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "youtube",
          permission: "__unknown__",
          action: "deny",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "slack",
          permission: "youtube",
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
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            inArray(userPermissionGrants.permission, [
              "__unknown__",
              "search.read",
              "tests.create",
              "videos.create",
              "videos.read",
              "youtube",
              "youtube.readonly",
            ]),
          ),
        )
        .orderBy(
          asc(userPermissionGrants.connectorRef),
          asc(userPermissionGrants.permission),
        );

      expect(grants).toStrictEqual([
        {
          connectorRef: "slack",
          permission: "youtube",
          action: "deny",
          expiresAt: new Date("2040-01-01T00:00:00Z"),
        },
        {
          connectorRef: "youtube",
          permission: "__unknown__",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "youtube",
          permission: "search.read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "youtube",
          permission: "tests.create",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "youtube",
          permission: "videos.create",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "youtube",
          permission: "videos.read",
          action: "deny",
          expiresAt: null,
        },
      ]);
    });
  });

  it("preserves old YouTube allow grants by route overlap", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const agentId = await createAgent(tx, orgId, ownerId);

      const usersByOldPermission = new Map<string, string>();
      await tx.insert(userPermissionGrants).values(
        Object.keys(OLD_PERMISSION_REMAPS).map((permission) => {
          const userId = uniqueId("user");
          usersByOldPermission.set(permission, userId);
          return {
            orgId,
            userId,
            agentId,
            connectorRef: "youtube",
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
        OLD_PERMISSION_REMAPS,
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

  it("expands old YouTube deny grants by route overlap", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const agentId = await createAgent(tx, orgId, ownerId);

      const usersByOldPermission = new Map<string, string>();
      await tx.insert(userPermissionGrants).values(
        Object.keys(OLD_PERMISSION_REMAPS).map((permission) => {
          const userId = uniqueId("user");
          usersByOldPermission.set(permission, userId);
          return {
            orgId,
            userId,
            agentId,
            connectorRef: "youtube",
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
        OLD_PERMISSION_REMAPS,
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
