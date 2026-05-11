import { command } from "ccstate";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { logger } from "../../lib/log";
import {
  getOrgBillingPeriod$,
  type OrgBillingPeriod,
} from "./zero-org-billing-period.service";

const L = logger("MemberCapEvaluator");

interface UsageTotalRow {
  readonly userId: string;
  readonly total: number;
}

async function getProcessedUsageTotalsByUser(
  writeDb: Db,
  orgId: string,
  userIds: readonly string[],
  billingPeriod: OrgBillingPeriod,
): Promise<Map<string, number>> {
  const uniqueUserIds = [...new Set(userIds)];
  const usageMap = new Map<string, number>();
  if (uniqueUserIds.length === 0) {
    return usageMap;
  }

  const eventRows: UsageTotalRow[] = await writeDb
    .select({
      userId: usageEvent.userId,
      total:
        sql<number>`COALESCE(SUM(${usageEvent.creditsCharged}), 0)::bigint`.as(
          "total",
        ),
    })
    .from(usageEvent)
    .where(
      and(
        eq(usageEvent.orgId, orgId),
        inArray(usageEvent.userId, uniqueUserIds),
        eq(usageEvent.status, "processed"),
        gte(usageEvent.processedAt, billingPeriod.start),
        lt(usageEvent.processedAt, billingPeriod.end),
      ),
    )
    .groupBy(usageEvent.userId);

  for (const row of eventRows) {
    usageMap.set(
      row.userId,
      (usageMap.get(row.userId) ?? 0) + Number(row.total),
    );
  }
  return usageMap;
}

/**
 * Re-evaluate per-user spend caps for the affected members of an org.
 *
 * For any `(orgId, userId)` whose total processed usage in the current
 * billing period now meets or exceeds their `creditCap`, flip
 * `creditEnabled` to false. Race-safe via a WHERE predicate that
 * re-checks `creditEnabled = true` and `creditCap = <observed>`: a
 * concurrent admin re-enable, or a concurrent cap change, no-ops the
 * disable.
 *
 * Mirrors apps/web's `evaluateMemberCaps`. Caller is expected to gate on
 * `affectedUserIds.length > 0` upstream — a no-affected call is a no-op
 * but the upstream gate avoids the empty round-trip.
 *
 * Returns void; observable contract is on the DB row.
 */
export const evaluateMemberCaps$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly affectedUserIds: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.affectedUserIds.length === 0) {
      return;
    }

    const billingPeriod = await set(getOrgBillingPeriod$, args.orgId, signal);
    signal.throwIfAborted();
    if (!billingPeriod) {
      return;
    }

    const writeDb = set(writeDb$);

    const cappedMembers = await writeDb
      .select({
        userId: orgMembersMetadata.userId,
        creditCap: orgMembersMetadata.creditCap,
        creditEnabled: orgMembersMetadata.creditEnabled,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          inArray(orgMembersMetadata.userId, [...args.affectedUserIds]),
          sql`${orgMembersMetadata.creditCap} IS NOT NULL`,
        ),
      );
    signal.throwIfAborted();

    const enabledCapped = cappedMembers.filter((m) => {
      return m.creditEnabled && m.creditCap !== null;
    });
    if (enabledCapped.length === 0) {
      return;
    }

    const usageMap = await getProcessedUsageTotalsByUser(
      writeDb,
      args.orgId,
      enabledCapped.map((m) => {
        return m.userId;
      }),
      billingPeriod,
    );
    signal.throwIfAborted();

    for (const member of enabledCapped) {
      const totalUsage = usageMap.get(member.userId) ?? 0;
      const cap = member.creditCap;
      if (cap !== null && totalUsage >= cap) {
        await writeDb
          .update(orgMembersMetadata)
          .set({ creditEnabled: false, updatedAt: nowDate() })
          .where(
            and(
              eq(orgMembersMetadata.orgId, args.orgId),
              eq(orgMembersMetadata.userId, member.userId),
              eq(orgMembersMetadata.creditEnabled, true),
              eq(orgMembersMetadata.creditCap, cap),
            ),
          );
        signal.throwIfAborted();
        L.debug("member-cap disabled", {
          orgId: args.orgId,
          userId: member.userId,
          totalUsage,
          cap,
        });
      }
    }
  },
);
