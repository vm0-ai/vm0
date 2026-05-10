import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface ApiKeysFixture {
  readonly userId: string;
  readonly tokenIds: readonly string[];
}

interface ApiKeySeedValues {
  readonly name: string;
  readonly token: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt?: Date | null;
}

export const seedApiKeys$ = command(
  async (
    { set },
    rows: readonly ApiKeySeedValues[],
    signal: AbortSignal,
  ): Promise<ApiKeysFixture> => {
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);
    const tokenIds: string[] = [];

    if (rows.length > 0) {
      const inserts = rows.map((row) => {
        return {
          id: randomUUID(),
          userId,
          name: row.name,
          token: row.token,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          lastUsedAt: row.lastUsedAt ?? null,
        };
      });
      tokenIds.push(
        ...inserts.map((row) => {
          return row.id;
        }),
      );
      await writeDb.insert(cliTokens).values(inserts);
      signal.throwIfAborted();
    }

    return { userId, tokenIds };
  },
);

export const deleteApiKeys$ = command(
  async (
    { set },
    fixture: ApiKeysFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.delete(cliTokens).where(eq(cliTokens.userId, fixture.userId));
    signal.throwIfAborted();
  },
);
