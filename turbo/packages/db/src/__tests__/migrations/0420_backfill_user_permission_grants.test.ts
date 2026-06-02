import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type {
  FirewallPolicyValue,
  RawPermissionPolicies,
} from "@vm0/connectors/firewall-types";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { permissionAccessRequests } from "@vm0/db/schema/permission-access-request";
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

async function runMigration0420(): Promise<void> {
  await db.execute(sql.raw(migrationSql));
}

async function seedZeroAgent(params: {
  readonly orgId: string;
  readonly ownerId: string;
  readonly permissionPolicies: RawPermissionPolicies;
  readonly unknownPermissionPolicies: Record<string, FirewallPolicyValue>;
}): Promise<string> {
  const [compose] = await db
    .insert(agentComposes)
    .values({
      orgId: params.orgId,
      userId: params.ownerId,
      name: uniqueId("compose"),
    })
    .returning({ id: agentComposes.id });

  await db.insert(zeroAgents).values({
    id: compose!.id,
    orgId: params.orgId,
    owner: params.ownerId,
    name: uniqueId("agent"),
    permissionPolicies: params.permissionPolicies,
    unknownPermissionPolicies: params.unknownPermissionPolicies,
  });

  return compose!.id;
}

async function readGrants(orgId: string): Promise<readonly GrantRow[]> {
  return await db
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
}

describe("migration 0420 backfill user permission grants", () => {
  it("backfills legacy policies through user connectors and is idempotent", async () => {
    const orgId = uniqueId("org");
    const ownerId = uniqueId("owner");
    const userId = uniqueId("user");
    const otherUserId = uniqueId("other-user");
    const pendingRequesterId = uniqueId("requester");

    const agentId = await seedZeroAgent({
      orgId,
      ownerId,
      permissionPolicies: {
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
      },
      unknownPermissionPolicies: {
        github: "allow",
        gmail: "ask",
        slack: "deny",
      },
    });

    await db.insert(userConnectors).values([
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

    await db.insert(userPermissionGrants).values({
      orgId,
      userId,
      agentId,
      connectorRef: "slack",
      permission: "chat:write",
      action: "deny",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });

    await db.insert(permissionAccessRequests).values({
      orgId,
      agentId,
      requesterUserId: pendingRequesterId,
      connectorRef: "slack",
      permission: "files:read",
      action: "allow",
      status: "approved",
      resolvedBy: ownerId,
      resolvedAt: new Date("2030-01-01T00:00:00Z"),
    });

    await runMigration0420();
    await runMigration0420();

    expect(await readGrants(orgId)).toStrictEqual([
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

    const [githubGrant] = await db
      .select({ id: userPermissionGrants.id })
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.orgId, orgId),
          eq(userPermissionGrants.connectorRef, "github"),
        ),
      );
    expect(githubGrant).toBeUndefined();

    const [requestGrant] = await db
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

    const [grantCount] = await db
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
