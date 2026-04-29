import { randomUUID } from "node:crypto";

import type { Store } from "ccstate";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface ApiKeysFixture {
  readonly userId: string;
}

interface ApiKeySeedValues {
  readonly name: string;
  readonly token: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt?: Date | null;
}

export async function seedApiKeys(
  store: Store,
  rows: readonly ApiKeySeedValues[],
): Promise<ApiKeysFixture> {
  const fixture = { userId: `user_${randomUUID()}` };
  const writeDb = store.set(writeDb$);

  if (rows.length > 0) {
    await writeDb.insert(cliTokens).values(
      rows.map((row) => {
        return {
          id: randomUUID(),
          userId: fixture.userId,
          name: row.name,
          token: row.token,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          lastUsedAt: row.lastUsedAt ?? null,
        };
      }),
    );
  }

  return fixture;
}

export async function deleteApiKeys(
  store: Store,
  fixture: ApiKeysFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(cliTokens).where(eq(cliTokens.userId, fixture.userId));
}
