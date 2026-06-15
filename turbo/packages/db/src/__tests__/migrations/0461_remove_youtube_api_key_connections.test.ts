import { readFileSync } from "node:fs";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";

import { db, uniqueId } from "../test-db";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0461_remove_youtube_api_key_connections.sql",
    import.meta.url,
  ),
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

describe("migration 0461 remove YouTube API key connections", () => {
  it("removes YouTube API key connector state without deleting OAuth or user-scoped data", async () => {
    await runInRollbackTransaction(async (tx) => {
      const orgId = uniqueId("org");
      const userId = uniqueId("user");
      const disconnectedUserId = uniqueId("disconnected");
      const youtubeOauthUserId = uniqueId("youtube-oauth");

      await tx.insert(connectors).values([
        {
          orgId,
          userId,
          type: "youtube",
          authMethod: "api-token",
        },
        {
          orgId,
          userId,
          type: "cloudflare",
          authMethod: "oauth",
        },
        {
          orgId,
          userId: youtubeOauthUserId,
          type: "youtube",
          authMethod: "oauth",
        },
      ]);

      await tx.insert(secrets).values([
        {
          orgId,
          userId,
          name: "YOUTUBE_TOKEN",
          encryptedValue: "encrypted-api-key",
          type: "connector",
        },
        {
          orgId,
          userId,
          name: "YOUTUBE_ACCESS_TOKEN",
          encryptedValue: "encrypted-access-token",
          type: "connector",
        },
        {
          orgId,
          userId,
          name: "YOUTUBE_REFRESH_TOKEN",
          encryptedValue: "encrypted-refresh-token",
          type: "connector",
        },
        {
          orgId,
          userId,
          name: "CLOUDFLARE_API_TOKEN",
          encryptedValue: "encrypted-cloudflare-token",
          type: "connector",
        },
        {
          orgId,
          userId,
          name: "YOUTUBE_TOKEN",
          encryptedValue: "encrypted-user-token",
          type: "user",
        },
        {
          orgId,
          userId: disconnectedUserId,
          name: "YOUTUBE_TOKEN",
          encryptedValue: "encrypted-disconnected-token",
          type: "connector",
        },
        {
          orgId,
          userId: youtubeOauthUserId,
          name: "YOUTUBE_ACCESS_TOKEN",
          encryptedValue: "encrypted-oauth-access-token",
          type: "connector",
        },
        {
          orgId,
          userId: youtubeOauthUserId,
          name: "YOUTUBE_REFRESH_TOKEN",
          encryptedValue: "encrypted-oauth-refresh-token",
          type: "connector",
        },
      ]);

      await tx.insert(variables).values([
        {
          orgId,
          userId,
          name: "YOUTUBE_TOKEN",
          value: "legacy-variable-token",
          type: "connector",
        },
        {
          orgId,
          userId,
          name: "YOUTUBE_TOKEN",
          value: "user-variable-token",
          type: "user",
        },
        {
          orgId,
          userId,
          name: "CLOUDFLARE_ACCOUNT_ID",
          value: "cloudflare-account",
          type: "connector",
        },
      ]);

      await tx.execute(sql.raw(migrationSql));
      await tx.execute(sql.raw(migrationSql));

      const connectorRows = await tx
        .select({
          userId: connectors.userId,
          type: connectors.type,
          authMethod: connectors.authMethod,
        })
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, orgId),
            inArray(connectors.userId, [
              userId,
              disconnectedUserId,
              youtubeOauthUserId,
            ]),
          ),
        )
        .orderBy(asc(connectors.type), asc(connectors.userId));

      const secretRows = await tx
        .select({
          userId: secrets.userId,
          name: secrets.name,
          encryptedValue: secrets.encryptedValue,
          type: secrets.type,
        })
        .from(secrets)
        .where(
          and(
            eq(secrets.orgId, orgId),
            inArray(secrets.userId, [
              userId,
              disconnectedUserId,
              youtubeOauthUserId,
            ]),
          ),
        )
        .orderBy(asc(secrets.userId), asc(secrets.type), asc(secrets.name));

      const variableRows = await tx
        .select({
          name: variables.name,
          value: variables.value,
          type: variables.type,
        })
        .from(variables)
        .where(and(eq(variables.orgId, orgId), eq(variables.userId, userId)))
        .orderBy(asc(variables.type), asc(variables.name));

      expect(connectorRows).toStrictEqual([
        {
          userId,
          type: "cloudflare",
          authMethod: "oauth",
        },
        {
          userId: youtubeOauthUserId,
          type: "youtube",
          authMethod: "oauth",
        },
      ]);
      expect(secretRows).toStrictEqual([
        {
          userId: disconnectedUserId,
          name: "YOUTUBE_TOKEN",
          encryptedValue: "encrypted-disconnected-token",
          type: "connector",
        },
        {
          userId,
          name: "CLOUDFLARE_API_TOKEN",
          encryptedValue: "encrypted-cloudflare-token",
          type: "connector",
        },
        {
          userId,
          name: "YOUTUBE_TOKEN",
          encryptedValue: "encrypted-user-token",
          type: "user",
        },
        {
          userId: youtubeOauthUserId,
          name: "YOUTUBE_ACCESS_TOKEN",
          encryptedValue: "encrypted-oauth-access-token",
          type: "connector",
        },
        {
          userId: youtubeOauthUserId,
          name: "YOUTUBE_REFRESH_TOKEN",
          encryptedValue: "encrypted-oauth-refresh-token",
          type: "connector",
        },
      ]);
      expect(variableRows).toStrictEqual([
        {
          name: "CLOUDFLARE_ACCOUNT_ID",
          value: "cloudflare-account",
          type: "connector",
        },
        {
          name: "YOUTUBE_TOKEN",
          value: "user-variable-token",
          type: "user",
        },
      ]);
    });
  });
});
