import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0494_remap_stripe_permission_grants.sql",
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

interface StripePermissionRemapCase {
  readonly oldPermission: string;
  readonly newPermissions: readonly string[];
  readonly retainOldPermission?: boolean;
}

type TransactionCallback = Parameters<typeof db.transaction>[0];
type Transaction = Parameters<TransactionCallback>[0];

class RollbackMigrationTestTransaction extends Error {}

const STRIPE_PERMISSION_REMAPS: readonly StripePermissionRemapCase[] = [
  {
    oldPermission: "account_write",
    newPermissions: ["source_write"],
    retainOldPermission: true,
  },
  {
    oldPermission: "bank_account_read",
    newPermissions: ["external_account_read", "source_read"],
  },
  {
    oldPermission: "bank_account_write",
    newPermissions: ["external_account_write", "source_write"],
    retainOldPermission: true,
  },
  {
    oldPermission: "card_read",
    newPermissions: ["external_account_read", "source_read"],
  },
  {
    oldPermission: "card_write",
    newPermissions: ["external_account_write", "source_write"],
  },
  {
    oldPermission: "connected_account_read",
    newPermissions: ["source_read"],
    retainOldPermission: true,
  },
  {
    oldPermission: "payment_source_read",
    newPermissions: ["source_read"],
  },
  {
    oldPermission: "payment_source_write",
    newPermissions: ["source_write"],
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

describe("migration 0494 remap Stripe permission grants", () => {
  it("expands every legacy Stripe route-owner grant to the new owners", async () => {
    await runInRollbackTransaction(async (tx) => {
      const seededCases: Array<
        StripePermissionRemapCase & { readonly orgId: string }
      > = [];
      const expiresAt = new Date("2030-01-01T00:00:00Z");

      for (const [index, remap] of STRIPE_PERMISSION_REMAPS.entries()) {
        const orgId = uniqueId(`org-${index}`);
        const ownerId = uniqueId(`owner-${index}`);
        const userId = uniqueId(`user-${index}`);
        const agentId = await createAgent(tx, orgId, ownerId);

        await tx.insert(userPermissionGrants).values({
          orgId,
          userId,
          agentId,
          connectorRef: "stripe",
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

  it("resolves conflicts, deletes removed names, leaves other connectors unchanged, and is idempotent", async () => {
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
          connectorRef: "stripe",
          permission: "bank_account_read",
          action: "allow",
          expiresAt: new Date("2030-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "stripe",
          permission: "card_read",
          action: "deny",
          expiresAt: new Date("2031-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "stripe",
          permission: "card_write",
          action: "allow",
          expiresAt: null,
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "stripe",
          permission: "bank_account_write",
          action: "deny",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "stripe",
          permission: "source_write",
          action: "allow",
          expiresAt: new Date("2033-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "stripe",
          permission: "connected_account_read",
          action: "allow",
          expiresAt: new Date("2034-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "stripe",
          permission: "payment_source_read",
          action: "allow",
          expiresAt: new Date("2035-01-01T00:00:00Z"),
        },
        {
          orgId,
          userId,
          agentId,
          connectorRef: "gmail",
          permission: "card_read",
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
          permission: "card_read",
          action: "allow",
          expiresAt: new Date("2040-01-01T00:00:00Z"),
        },
        {
          connectorRef: "stripe",
          permission: "bank_account_write",
          action: "deny",
          expiresAt: new Date("2032-01-01T00:00:00Z"),
        },
        {
          connectorRef: "stripe",
          permission: "connected_account_read",
          action: "allow",
          expiresAt: new Date("2034-01-01T00:00:00Z"),
        },
        {
          connectorRef: "stripe",
          permission: "external_account_read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "stripe",
          permission: "external_account_write",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "stripe",
          permission: "source_read",
          action: "deny",
          expiresAt: null,
        },
        {
          connectorRef: "stripe",
          permission: "source_write",
          action: "deny",
          expiresAt: null,
        },
      ]);
    });
  });
});
