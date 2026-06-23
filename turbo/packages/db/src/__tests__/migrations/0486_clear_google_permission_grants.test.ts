import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0486_clear_google_permission_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

const CLEARED_CONNECTOR_REFS = [
  "gmail",
  "google-analytics",
  "google-calendar",
  "google-docs",
  "google-drive",
  "google-meet",
  "google-search-console",
  "google-sheets",
  "youtube",
] as const;

const PRESERVED_CONNECTOR_REFS = [
  "google-ads",
  "google-cloud",
  "google-maps",
  "slack",
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

describe("migration 0486 clear Google permission grants", () => {
  it("deletes remapped Google-series grants and preserves unrelated connectors", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const ownerId = uniqueId("owner");
      const userId = uniqueId("user");
      const agentId = await createAgent(tx, orgId, ownerId);

      await tx.insert(userPermissionGrants).values([
        ...CLEARED_CONNECTOR_REFS.map((connectorRef) => {
          return {
            orgId,
            userId,
            agentId,
            connectorRef,
            permission: "custom.permission",
            action: "allow" as const,
            expiresAt: new Date("2030-01-01T00:00:00Z"),
          };
        }),
        ...PRESERVED_CONNECTOR_REFS.map((connectorRef) => {
          return {
            orgId,
            userId,
            agentId,
            connectorRef,
            permission: "custom.permission",
            action: "deny" as const,
            expiresAt: null,
          };
        }),
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
        .orderBy(asc(userPermissionGrants.connectorRef));

      expect(grants).toStrictEqual(
        PRESERVED_CONNECTOR_REFS.map((connectorRef) => {
          return {
            connectorRef,
            permission: "custom.permission",
            action: "deny",
            expiresAt: null,
          };
        }),
      );
    });
  });
});
