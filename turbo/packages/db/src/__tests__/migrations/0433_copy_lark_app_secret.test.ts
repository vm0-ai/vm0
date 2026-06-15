import { readFileSync } from "node:fs";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { secrets } from "@vm0/db/schema/secret";

import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL("../../migrations/0433_copy_lark_app_secret.sql", import.meta.url),
  "utf8",
);

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

describe("migration 0433 copy Lark app secret", () => {
  it("copies legacy connector-owned LARK_TOKEN without overwrite or deletion", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const userId = uniqueId("user");
      const existingSecretUserId = uniqueId("existing-secret-user");
      const userSecretUserId = uniqueId("user-secret-user");

      await tx.insert(secrets).values([
        {
          orgId,
          userId,
          name: "LARK_TOKEN",
          encryptedValue: "encrypted-legacy-app-secret",
          description: "legacy connector Lark app secret",
          type: "connector",
        },
        {
          orgId,
          userId: existingSecretUserId,
          name: "LARK_TOKEN",
          encryptedValue: "encrypted-existing-legacy-app-secret",
          description: "legacy connector Lark app secret",
          type: "connector",
        },
        {
          orgId,
          userId: existingSecretUserId,
          name: "LARK_APP_SECRET",
          encryptedValue: "encrypted-existing-app-secret",
          description: "already migrated",
          type: "connector",
        },
        {
          orgId,
          userId: userSecretUserId,
          name: "LARK_TOKEN",
          encryptedValue: "encrypted-user-secret",
          description: "user secret should not migrate",
          type: "user",
        },
      ]);

      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql.raw(migrationSql));

      const rows = await tx
        .select({
          userId: secrets.userId,
          name: secrets.name,
          encryptedValue: secrets.encryptedValue,
          description: secrets.description,
          type: secrets.type,
        })
        .from(secrets)
        .where(
          and(
            eq(secrets.orgId, orgId),
            inArray(secrets.userId, [
              userId,
              existingSecretUserId,
              userSecretUserId,
            ]),
          ),
        )
        .orderBy(asc(secrets.userId), asc(secrets.type), asc(secrets.name));

      expect(rows).toStrictEqual([
        {
          userId: existingSecretUserId,
          name: "LARK_APP_SECRET",
          encryptedValue: "encrypted-existing-app-secret",
          description: "already migrated",
          type: "connector",
        },
        {
          userId: existingSecretUserId,
          name: "LARK_TOKEN",
          encryptedValue: "encrypted-existing-legacy-app-secret",
          description: "legacy connector Lark app secret",
          type: "connector",
        },
        {
          userId: userId,
          name: "LARK_APP_SECRET",
          encryptedValue: "encrypted-legacy-app-secret",
          description: "legacy connector Lark app secret",
          type: "connector",
        },
        {
          userId: userId,
          name: "LARK_TOKEN",
          encryptedValue: "encrypted-legacy-app-secret",
          description: "legacy connector Lark app secret",
          type: "connector",
        },
        {
          userId: userSecretUserId,
          name: "LARK_TOKEN",
          encryptedValue: "encrypted-user-secret",
          description: "user secret should not migrate",
          type: "user",
        },
      ]);
    });
  });
});
