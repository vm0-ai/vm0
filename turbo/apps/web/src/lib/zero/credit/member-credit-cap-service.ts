import { eq, and, sql, gte, lt, inArray } from "drizzle-orm";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { getOrgBillingPeriod } from "../org/org-metadata-service";

interface BillingPeriod {
  start: Date;
  end: Date;
}

interface UsageTotalRow {
  userId: string;
  total: number;
}

/**
 * Get a member's credit cap state.
 * Returns defaults (null cap, enabled) if no row exists.
 */
export async function getMemberCreditCap(
  orgId: string,
  userId: string,
): Promise<{ creditCap: number | null; creditEnabled: boolean }> {
  const db = globalThis.services.db;

  const [row] = await db
    .select({
      creditCap: orgMembersMetadata.creditCap,
      creditEnabled: orgMembersMetadata.creditEnabled,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    )
    .limit(1);

  if (!row) {
    return { creditCap: null, creditEnabled: true };
  }

  return { creditCap: row.creditCap, creditEnabled: row.creditEnabled };
}

/**
 * Set or clear a member's credit cap.
 * - If cap is null: removes the cap and re-enables the member.
 * - If cap is a number: re-evaluates immediately against current usage.
 */
export async function setMemberCreditCap(
  orgId: string,
  userId: string,
  cap: number | null,
): Promise<{ creditCap: number | null; creditEnabled: boolean }> {
  const db = globalThis.services.db;

  if (cap === null) {
    // Removing cap — always re-enable
    await db
      .insert(orgMembersMetadata)
      .values({
        orgId,
        userId,
        creditCap: null,
        creditEnabled: true,
      })
      .onConflictDoUpdate({
        target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
        set: {
          creditCap: null,
          creditEnabled: true,
          updatedAt: new Date(),
        },
      });

    return { creditCap: null, creditEnabled: true };
  }

  // Setting a numeric cap — re-evaluate against current usage
  const usage = await getMemberUsageInBillingPeriod(orgId, userId);
  const creditEnabled = usage < cap;

  await db
    .insert(orgMembersMetadata)
    .values({
      orgId,
      userId,
      creditCap: cap,
      creditEnabled,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        creditCap: cap,
        creditEnabled,
        updatedAt: new Date(),
      },
    });

  return { creditCap: cap, creditEnabled };
}

/**
 * Evaluate member caps for affected users after credit processing.
 * Only disables members (never re-enables). Called by usage processors.
 */
export async function evaluateMemberCaps(
  orgId: string,
  affectedUserIds: string[],
): Promise<void> {
  if (affectedUserIds.length === 0) return;

  const db = globalThis.services.db;

  // Skip if no billing period (free tier)
  const billingPeriod = await getOrgBillingPeriod(orgId);
  if (!billingPeriod) return;

  // Get capped members from the affected set
  const cappedMembers = await db
    .select({
      userId: orgMembersMetadata.userId,
      creditCap: orgMembersMetadata.creditCap,
      creditEnabled: orgMembersMetadata.creditEnabled,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        inArray(orgMembersMetadata.userId, affectedUserIds),
        sql`${orgMembersMetadata.creditCap} IS NOT NULL`,
      ),
    );

  // Filter to enabled members with caps set
  const enabledCapped = cappedMembers.filter((m) => {
    return m.creditEnabled && m.creditCap !== null;
  });
  if (enabledCapped.length === 0) return;

  const usageMap = await getProcessedUsageTotalsByUser(
    orgId,
    enabledCapped.map((m) => {
      return m.userId;
    }),
    billingPeriod,
  );

  for (const member of enabledCapped) {
    const totalUsage = usageMap.get(member.userId) ?? 0;
    const cap = member.creditCap;

    if (cap !== null && totalUsage >= cap) {
      await db
        .update(orgMembersMetadata)
        .set({ creditEnabled: false, updatedAt: new Date() })
        .where(
          and(
            eq(orgMembersMetadata.orgId, orgId),
            eq(orgMembersMetadata.userId, member.userId),
            eq(orgMembersMetadata.creditEnabled, true),
            eq(orgMembersMetadata.creditCap, cap),
          ),
        );
    }
  }
}

async function getProcessedUsageTotalsByUser(
  orgId: string,
  userIds: string[],
  billingPeriod: BillingPeriod,
): Promise<Map<string, number>> {
  const uniqueUserIds = [...new Set(userIds)];
  const usageMap = new Map<string, number>();
  if (uniqueUserIds.length === 0) return usageMap;

  const db = globalThis.services.db;

  const eventRows = await db
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

  addUsageRows(usageMap, eventRows);

  return usageMap;
}

function addUsageRows(
  usageMap: Map<string, number>,
  rows: UsageTotalRow[],
): void {
  for (const row of rows) {
    usageMap.set(
      row.userId,
      (usageMap.get(row.userId) ?? 0) + Number(row.total),
    );
  }
}

/**
 * Reset creditEnabled flags for all disabled members in an org.
 * Called on billing cycle reset (handleInvoicePaid).
 */
export async function resetMemberCreditFlags(orgId: string): Promise<void> {
  const db = globalThis.services.db;

  await db
    .update(orgMembersMetadata)
    .set({ creditEnabled: true, updatedAt: new Date() })
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.creditEnabled, false),
      ),
    );
}

/**
 * Get a member's total processed usage_event credits in the current billing period.
 */
async function getMemberUsageInBillingPeriod(
  orgId: string,
  userId: string,
): Promise<number> {
  const billingPeriod = await getOrgBillingPeriod(orgId);
  if (!billingPeriod) return 0;

  const usageMap = await getProcessedUsageTotalsByUser(orgId, [userId], {
    start: billingPeriod.start,
    end: billingPeriod.end,
  });

  return usageMap.get(userId) ?? 0;
}
