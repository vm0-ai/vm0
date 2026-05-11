import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface AutoRechargeOrgFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface AutoRechargeSeedValues {
  readonly enabled?: boolean;
  readonly threshold?: number | null;
  readonly amount?: number | null;
  readonly tier?: string;
  readonly pendingAt?: Date | null;
}

export const seedAutoRechargeOrg$ = command(
  async (
    { set },
    values: AutoRechargeSeedValues,
    signal: AbortSignal,
  ): Promise<AutoRechargeOrgFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const writeDb = set(writeDb$);

    await writeDb.insert(orgMetadata).values({
      orgId,
      autoRechargeEnabled: values.enabled ?? false,
      autoRechargeThreshold: values.threshold ?? null,
      autoRechargeAmount: values.amount ?? null,
      ...(values.tier !== undefined ? { tier: values.tier } : {}),
      ...(values.pendingAt !== undefined
        ? { autoRechargePendingAt: values.pendingAt }
        : {}),
    });
    signal.throwIfAborted();

    return { orgId, userId };
  },
);

export const deleteAutoRechargeOrg$ = command(
  async (
    { set },
    fixture: AutoRechargeOrgFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);
