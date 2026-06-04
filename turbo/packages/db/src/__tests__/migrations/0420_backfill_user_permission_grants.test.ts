import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0420_backfill_user_permission_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

interface GrantRow {
  readonly userId: string;
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

describe("migration 0420 backfill user permission grants", () => {
  it("backfills legacy policies through user connectors and is idempotent", async () => {
    await runInRollbackTransaction(async (tx) => {
      await tx.execute(sql`
        ALTER TABLE zero_agents
          ADD COLUMN IF NOT EXISTS permission_policies jsonb,
          ADD COLUMN IF NOT EXISTS unknown_permission_policies jsonb
      `);
      await tx.execute(sql`
        CREATE TABLE IF NOT EXISTS permission_access_requests (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id text NOT NULL,
          agent_id uuid NOT NULL,
          requester_user_id text NOT NULL,
          connector_ref varchar(64) NOT NULL,
          permission varchar(128) NOT NULL,
          action varchar(10) NOT NULL DEFAULT 'allow',
          method varchar(10),
          path text,
          reason text,
          status varchar(20) NOT NULL DEFAULT 'pending',
          resolved_by text,
          resolved_at timestamp,
          created_at timestamp DEFAULT now() NOT NULL
        )
      `);

      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const userId = uniqueId("user");
      const otherUserId = uniqueId("other-user");
      const pendingRequesterId = uniqueId("requester");

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
      await tx.execute(sql`
        UPDATE zero_agents
        SET
          permission_policies = ${JSON.stringify({
            github: {
              "pull_request:read": "allow",
            },
            gmail: {
              "gmail.send": "deny",
            },
            slack: {
              __unknown__: "allow",
              "channels:history": "ask",
              "chat:write": "allow",
            },
          })}::jsonb,
          unknown_permission_policies = ${JSON.stringify({
            github: "allow",
            gmail: "ask",
            slack: "deny",
          })}::jsonb
        WHERE id = ${agentId}
      `);

      await tx.insert(userConnectors).values([
        {
          orgId,
          userId,
          agentId,
          connectorType: "gmail",
        },
        {
          orgId,
          userId,
          agentId,
          connectorType: "slack",
        },
        {
          orgId,
          userId: otherUserId,
          agentId,
          connectorType: "slack",
        },
      ]);

      await tx.insert(userPermissionGrants).values({
        orgId,
        userId,
        agentId,
        connectorRef: "slack",
        permission: "chat:write",
        action: "deny",
        expiresAt: new Date("2030-01-01T00:00:00Z"),
      });

      await tx.execute(sql`
        INSERT INTO permission_access_requests (
          org_id,
          agent_id,
          requester_user_id,
          connector_ref,
          permission,
          action,
          status,
          resolved_by,
          resolved_at
        )
        VALUES (
          ${orgId},
          ${agentId},
          ${pendingRequesterId},
          'slack',
          'files:read',
          'allow',
          'approved',
          ${ownerId},
          ${new Date("2030-01-01T00:00:00Z")}
        )
      `);

      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql.raw(migrationSql));

      const grants: readonly GrantRow[] = await tx
        .select({
          userId: userPermissionGrants.userId,
          connectorRef: userPermissionGrants.connectorRef,
          permission: userPermissionGrants.permission,
          action: userPermissionGrants.action,
          expiresAt: userPermissionGrants.expiresAt,
        })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.orgId, orgId))
        .orderBy(
          asc(userPermissionGrants.userId),
          asc(userPermissionGrants.connectorRef),
          asc(userPermissionGrants.permission),
        );
      expect(grants).toStrictEqual([
        {
          userId: otherUserId,
          connectorRef: "slack",
          permission: "__unknown__",
          action: "deny",
          expiresAt: null,
        },
        {
          userId: otherUserId,
          connectorRef: "slack",
          permission: "channels:history",
          action: "deny",
          expiresAt: null,
        },
        {
          userId: otherUserId,
          connectorRef: "slack",
          permission: "chat:write",
          action: "allow",
          expiresAt: null,
        },
        {
          userId,
          connectorRef: "gmail",
          permission: "__unknown__",
          action: "deny",
          expiresAt: null,
        },
        {
          userId,
          connectorRef: "gmail",
          permission: "gmail.send",
          action: "deny",
          expiresAt: null,
        },
        {
          userId,
          connectorRef: "slack",
          permission: "__unknown__",
          action: "deny",
          expiresAt: null,
        },
        {
          userId,
          connectorRef: "slack",
          permission: "channels:history",
          action: "deny",
          expiresAt: null,
        },
        {
          userId,
          connectorRef: "slack",
          permission: "chat:write",
          action: "allow",
          expiresAt: null,
        },
      ]);

      const [githubGrant] = await tx
        .select({ id: userPermissionGrants.id })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.connectorRef, "github"),
          ),
        );
      expect(githubGrant).toBeUndefined();

      const [requestGrant] = await tx
        .select({ id: userPermissionGrants.id })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            eq(userPermissionGrants.userId, pendingRequesterId),
            eq(userPermissionGrants.permission, "files:read"),
          ),
        );
      expect(requestGrant).toBeUndefined();

      const [grantCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(userPermissionGrants)
        .where(
          and(
            eq(userPermissionGrants.orgId, orgId),
            inArray(userPermissionGrants.userId, [userId, otherUserId]),
          ),
        );
      expect(grantCount!.count).toBe(8);
    });
  });
});
