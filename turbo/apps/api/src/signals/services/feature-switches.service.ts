import { command, computed, type Computed } from "ccstate";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { and, eq } from "drizzle-orm";

import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";

const ORG_SENTINEL_USER_ID = "__org__";

function isOrgScopedFeatureSwitchKey(key: string): boolean {
  return key === FeatureSwitchKey.DataExport;
}

function splitFeatureSwitchesByScope(switches: Record<string, boolean>): {
  readonly userSwitches: Record<string, boolean>;
  readonly orgSwitches: Record<string, boolean>;
} {
  const userSwitches: Record<string, boolean> = {};
  const orgSwitches: Record<string, boolean> = {};

  for (const [key, value] of Object.entries(switches)) {
    if (isOrgScopedFeatureSwitchKey(key)) {
      orgSwitches[key] = value;
    } else {
      userSwitches[key] = value;
    }
  }

  return { userSwitches, orgSwitches };
}

function hasSwitches(switches: Record<string, boolean>): boolean {
  return Object.keys(switches).length > 0;
}

function mergeScopedFeatureSwitches(
  userSwitches: Record<string, boolean>,
  orgSwitches: Record<string, boolean>,
): Record<string, boolean> {
  const merged: Record<string, boolean> = {};

  for (const [key, value] of Object.entries(userSwitches)) {
    if (!isOrgScopedFeatureSwitchKey(key)) {
      merged[key] = value;
    }
  }

  for (const [key, value] of Object.entries(orgSwitches)) {
    if (isOrgScopedFeatureSwitchKey(key)) {
      merged[key] = value;
    }
  }

  return merged;
}

async function loadFeatureSwitchOverrideRow(
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

async function loadUserFeatureSwitchOverrides(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<Record<string, boolean>> {
  const [userSwitches, orgSwitches] = await Promise.all([
    loadFeatureSwitchOverrideRow(db, orgId, userId),
    loadFeatureSwitchOverrideRow(db, orgId, ORG_SENTINEL_USER_ID),
  ]);

  return mergeScopedFeatureSwitches(userSwitches, orgSwitches);
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
    const { userSwitches, orgSwitches } = splitFeatureSwitchesByScope(
      args.switches,
    );

    if (hasSwitches(userSwitches)) {
      await upsertFeatureSwitches(
        writeDb,
        args.orgId,
        args.userId,
        userSwitches,
        signal,
      );
    }

    if (hasSwitches(orgSwitches)) {
      await upsertFeatureSwitches(
        writeDb,
        args.orgId,
        ORG_SENTINEL_USER_ID,
        orgSwitches,
        signal,
      );
    }

    return await loadUserFeatureSwitchOverrides(
      writeDb,
      args.orgId,
      args.userId,
    );
  },
);

async function upsertFeatureSwitches(
  writeDb: Db,
  orgId: string,
  userId: string,
  switches: Record<string, boolean>,
  signal: AbortSignal,
): Promise<void> {
  const [existingRow] = await writeDb
    .select({ switches: userFeatureSwitches.switches })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  const existing =
    (existingRow?.switches as Record<string, boolean> | undefined) ?? {};
  const merged: Record<string, boolean> = { ...existing, ...switches };
  const now = nowDate();

  await writeDb
    .insert(userFeatureSwitches)
    .values({
      orgId,
      userId,
      switches: merged,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: { switches: merged, updatedAt: now },
    });
  signal.throwIfAborted();
}

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

    await removeOrgScopedFeatureSwitches(writeDb, args.orgId, signal);
  },
);

async function removeOrgScopedFeatureSwitches(
  writeDb: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const [existingRow] = await writeDb
    .select({ switches: userFeatureSwitches.switches })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, ORG_SENTINEL_USER_ID),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!existingRow) {
    return;
  }

  const next = { ...existingRow.switches };
  delete next[FeatureSwitchKey.DataExport];

  if (Object.keys(next).length === 0) {
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, orgId),
          eq(userFeatureSwitches.userId, ORG_SENTINEL_USER_ID),
        ),
      );
    signal.throwIfAborted();
    return;
  }

  await writeDb
    .update(userFeatureSwitches)
    .set({ switches: next, updatedAt: nowDate() })
    .where(
      and(
        eq(userFeatureSwitches.orgId, orgId),
        eq(userFeatureSwitches.userId, ORG_SENTINEL_USER_ID),
      ),
    );
  signal.throwIfAborted();
}
