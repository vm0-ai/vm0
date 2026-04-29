import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface FeatureSwitchesFixture {
  readonly orgId: string;
  readonly userId: string;
}

export const seedFeatureSwitches$ = command(
  async (
    { set },
    switches: Record<string, boolean>,
    signal: AbortSignal,
  ): Promise<FeatureSwitchesFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    await writeDb.insert(userFeatureSwitches).values({
      orgId,
      userId,
      switches,
    });
    signal.throwIfAborted();

    return { orgId, userId };
  },
);

export const deleteFeatureSwitches$ = command(
  async (
    { set },
    fixture: FeatureSwitchesFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, fixture.orgId),
          eq(userFeatureSwitches.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
  },
);
