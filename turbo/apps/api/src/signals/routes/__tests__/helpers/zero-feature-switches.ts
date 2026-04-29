import { randomUUID } from "node:crypto";

import type { Store } from "ccstate";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface FeatureSwitchesFixture {
  readonly orgId: string;
  readonly userId: string;
}

export async function seedFeatureSwitches(
  store: Store,
  switches: Record<string, boolean>,
): Promise<FeatureSwitchesFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const writeDb = store.set(writeDb$);

  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches,
  });

  return { orgId, userId };
}

export async function deleteFeatureSwitches(
  store: Store,
  fixture: FeatureSwitchesFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
}
