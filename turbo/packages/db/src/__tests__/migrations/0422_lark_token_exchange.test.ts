import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL("../../migrations/0422_lark_token_exchange.sql", import.meta.url),
  "utf8",
);

async function runMigration(): Promise<void> {
  await db.execute(sql.raw(migrationSql));
}

async function larkAppSecretRows(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return await db
    .select({
      encryptedValue: secrets.encryptedValue,
      description: secrets.description,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, "LARK_APP_SECRET"),
        eq(secrets.type, "connector"),
      ),
    );
}

describe("0422_lark_token_exchange", () => {
  it("copies connector-owned LARK_TOKEN to LARK_APP_SECRET for Lark connectors", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.insert(connectors).values({
      orgId,
      userId,
      type: "lark",
      authMethod: "api-token",
    });
    await db.insert(secrets).values({
      orgId,
      userId,
      name: "LARK_TOKEN",
      encryptedValue: "encrypted-old-lark-app-secret",
      description: "legacy lark token",
      type: "connector",
    });

    await runMigration();

    await expect(larkAppSecretRows({ orgId, userId })).resolves.toStrictEqual([
      {
        encryptedValue: "encrypted-old-lark-app-secret",
        description: "Connector secret: LARK_APP_SECRET",
      },
    ]);
  });

  it("keeps an existing LARK_APP_SECRET value", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.insert(connectors).values({
      orgId,
      userId,
      type: "lark",
      authMethod: "api-token",
    });
    await db.insert(secrets).values([
      {
        orgId,
        userId,
        name: "LARK_TOKEN",
        encryptedValue: "encrypted-old-lark-app-secret",
        type: "connector",
      },
      {
        orgId,
        userId,
        name: "LARK_APP_SECRET",
        encryptedValue: "encrypted-existing-lark-app-secret",
        description: "existing app secret",
        type: "connector",
      },
    ]);

    await runMigration();

    await expect(larkAppSecretRows({ orgId, userId })).resolves.toStrictEqual([
      {
        encryptedValue: "encrypted-existing-lark-app-secret",
        description: "existing app secret",
      },
    ]);
  });

  it("does not copy orphaned LARK_TOKEN secrets", async () => {
    const orgId = uniqueId("org");
    const userId = uniqueId("user");
    await db.insert(secrets).values({
      orgId,
      userId,
      name: "LARK_TOKEN",
      encryptedValue: "encrypted-orphaned-lark-token",
      type: "connector",
    });

    await runMigration();

    await expect(larkAppSecretRows({ orgId, userId })).resolves.toStrictEqual(
      [],
    );
  });
});
