import { command, computed, type Computed } from "ccstate";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { and, eq } from "drizzle-orm";

import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";

async function loadUserFeatureSwitchOverrides(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<Record<string, boolean>> {
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
}

export function userFeatureSwitchOverrides(
  orgId: string,
  userId: string,
): Computed<Promise<Record<string, boolean>>> {
  return computed(async (get): Promise<Record<string, boolean>> => {
    const db = get(db$);
    return await loadUserFeatureSwitchOverrides(db, orgId, userId);
  });
}

export async function loadUserFeatureSwitchContext(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<FeatureSwitchContext> {
  return {
    orgId,
    userId,
    overrides: await loadUserFeatureSwitchOverrides(db, orgId, userId),
  };
}

export function userFeatureSwitchContext(
  orgId: string,
  userId: string,
): Computed<Promise<FeatureSwitchContext>> {
  return computed(async (get): Promise<FeatureSwitchContext> => {
    return {
      orgId,
      userId,
      overrides: await get(userFeatureSwitchOverrides(orgId, userId)),
    };
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
