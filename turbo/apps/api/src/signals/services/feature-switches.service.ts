import { command, computed, type Computed } from "ccstate";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { and, eq } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";

export function userFeatureSwitchOverrides(
  orgId: string,
  userId: string,
): Computed<Promise<Record<string, boolean>>> {
  return computed(async (get): Promise<Record<string, boolean>> => {
    const db = get(db$);
    const [row] = await db
      .select({ switches: userFeatureSwitches.switches })
      .from(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, orgId),
          eq(userFeatureSwitches.userId, userId),
        ),
      )
      .limit(1);

    return row?.switches ?? {};
  });
}

export const updateUserFeatureSwitches$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly switches: Record<string, boolean>;
    },
    signal: AbortSignal,
  ): Promise<Record<string, boolean>> => {
    const writeDb = set(writeDb$);

    const [existingRow] = await writeDb
      .select({ switches: userFeatureSwitches.switches })
      .from(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, args.orgId),
          eq(userFeatureSwitches.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    const existing =
      (existingRow?.switches as Record<string, boolean> | undefined) ?? {};
    const merged: Record<string, boolean> = { ...existing, ...args.switches };
    const now = nowDate();

    await writeDb
      .insert(userFeatureSwitches)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        switches: merged,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
        set: { switches: merged, updatedAt: now },
      });
    signal.throwIfAborted();

    return merged;
  },
);

export const deleteUserFeatureSwitches$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, args.orgId),
          eq(userFeatureSwitches.userId, args.userId),
        ),
      );
    signal.throwIfAborted();
  },
);
