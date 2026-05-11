import { command, computed, type Computed } from "ccstate";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { getOrgBillingPeriod$ } from "./zero-org-billing-period.service";

export function zeroMemberCreditCap(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<
  Promise<{
    readonly creditCap: number | null;
    readonly creditEnabled: boolean;
  }>
> {
  return computed(async (get) => {
    const [row] = await get(db$)
      .select({
        creditCap: orgMembersMetadata.creditCap,
        creditEnabled: orgMembersMetadata.creditEnabled,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.userId),
        ),
      )
      .limit(1);

    return {
      creditCap: row?.creditCap ?? null,
      creditEnabled: row?.creditEnabled ?? true,
    };
  });
}

interface MemberUsageArgs {
  readonly orgId: string;
  readonly userId: string;
}

// Single-user sum of processed usage_event.creditsCharged in the current
// billing period. Returns 0 when no billing period is set (free tier).
// Mirrors apps/web's private getMemberUsageInBillingPeriod.
const getMemberUsageInBillingPeriod$ = command(
  async (
    { set },
    args: MemberUsageArgs,
    signal: AbortSignal,
  ): Promise<number> => {
    const billingPeriod = await set(getOrgBillingPeriod$, args.orgId, signal);
    signal.throwIfAborted();
    if (!billingPeriod) {
      return 0;
    }
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .select({
        total:
          sql<number>`COALESCE(SUM(${usageEvent.creditsCharged}), 0)::bigint`.as(
            "total",
          ),
      })
      .from(usageEvent)
      .where(
        and(
          eq(usageEvent.orgId, args.orgId),
          eq(usageEvent.userId, args.userId),
          eq(usageEvent.status, "processed"),
          gte(usageEvent.processedAt, billingPeriod.start),
          lt(usageEvent.processedAt, billingPeriod.end),
        ),
      );
    signal.throwIfAborted();
    return Number(row?.total ?? 0);
  },
);

interface SetMemberCreditCapArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly creditCap: number | null;
}

interface SetMemberCreditCapResult {
  readonly creditCap: number | null;
  readonly creditEnabled: boolean;
}

export const setMemberCreditCap$ = command(
  async (
    { set },
    args: SetMemberCreditCapArgs,
    signal: AbortSignal,
  ): Promise<SetMemberCreditCapResult> => {
    const writeDb = set(writeDb$);
    const now = nowDate();

    if (args.creditCap === null) {
      await writeDb
        .insert(orgMembersMetadata)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          creditCap: null,
          creditEnabled: true,
        })
        .onConflictDoUpdate({
          target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
          set: { creditCap: null, creditEnabled: true, updatedAt: now },
        });
      signal.throwIfAborted();
      return { creditCap: null, creditEnabled: true };
    }

    const cap = args.creditCap;
    const usage = await set(
      getMemberUsageInBillingPeriod$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();
    const creditEnabled = usage < cap;
    await writeDb
      .insert(orgMembersMetadata)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        creditCap: cap,
        creditEnabled,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: { creditCap: cap, creditEnabled, updatedAt: now },
      });
    signal.throwIfAborted();
    return { creditCap: cap, creditEnabled };
  },
);
