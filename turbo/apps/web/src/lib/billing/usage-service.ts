import { sql, and, eq, gte, lt, inArray } from "drizzle-orm";
import { type MemberUsage, type UsageMembersResponse } from "@vm0/core";
import { getOrgBillingPeriod } from "../org/org-cache-service";
import { creditUsage } from "../../db/schema/credit-usage";
import { userCache } from "../../db/schema/user-cache";
import { orgMembersMetadata } from "../../db/schema/org-members-metadata";
import { clerkClient } from "@clerk/nextjs/server";

/**
 * Get per-member token usage aggregation for the current billing period.
 * Only includes credit_usage records with status = 'processed'.
 * Free tier orgs (no billing period) get { period: null, members: [] }.
 */
export async function getUsageMembers(
  orgId: string,
): Promise<UsageMembersResponse> {
  const billingPeriod = await getOrgBillingPeriod(orgId);

  if (!billingPeriod) {
    return { period: null, members: [] };
  }

  const db = globalThis.services.db;

  // Aggregate token usage per member for the billing period
  const rows = await db
    .select({
      userId: creditUsage.userId,
      inputTokens:
        sql<number>`COALESCE(SUM(${creditUsage.inputTokens}), 0)::bigint`.as(
          "input_tokens",
        ),
      outputTokens:
        sql<number>`COALESCE(SUM(${creditUsage.outputTokens}), 0)::bigint`.as(
          "output_tokens",
        ),
      cacheReadInputTokens:
        sql<number>`COALESCE(SUM(${creditUsage.cacheReadInputTokens}), 0)::bigint`.as(
          "cache_read_input_tokens",
        ),
      cacheCreationInputTokens:
        sql<number>`COALESCE(SUM(${creditUsage.cacheCreationInputTokens}), 0)::bigint`.as(
          "cache_creation_input_tokens",
        ),
      creditsCharged:
        sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
          "credits_charged",
        ),
    })
    .from(creditUsage)
    .where(
      and(
        eq(creditUsage.orgId, orgId),
        eq(creditUsage.status, "processed"),
        gte(creditUsage.createdAt, billingPeriod.start),
        lt(creditUsage.createdAt, billingPeriod.end),
      ),
    )
    .groupBy(creditUsage.userId);

  if (rows.length === 0) {
    return {
      period: {
        start: billingPeriod.start.toISOString(),
        end: billingPeriod.end.toISOString(),
      },
      members: [],
    };
  }

  // Resolve user emails from user_cache
  const userIds = rows.map((r) => r.userId);
  const cachedUsers = await db
    .select({ userId: userCache.userId, email: userCache.email })
    .from(userCache)
    .where(inArray(userCache.userId, userIds));

  const emailMap = new Map(cachedUsers.map((u) => [u.userId, u.email]));

  // Find missing users and fetch from Clerk
  const missingIds = userIds.filter((id) => !emailMap.has(id));
  if (missingIds.length > 0) {
    const client = await clerkClient();
    const clerkUsers = await client.users.getUserList({
      userId: missingIds,
      limit: missingIds.length,
    });

    const now = new Date();
    for (const user of clerkUsers.data) {
      const primaryEmail = user.emailAddresses.find(
        (e) => e.id === user.primaryEmailAddressId,
      );
      const email = primaryEmail?.emailAddress ?? "unknown";
      emailMap.set(user.id, email);

      // Upsert into user_cache
      await db
        .insert(userCache)
        .values({ userId: user.id, email, cachedAt: now })
        .onConflictDoUpdate({
          target: userCache.userId,
          set: { email, cachedAt: now },
        });
    }
  }

  // Fetch credit caps for all members in one query
  const capRows = await db
    .select({
      userId: orgMembersMetadata.userId,
      creditCap: orgMembersMetadata.creditCap,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        inArray(orgMembersMetadata.userId, userIds),
      ),
    );
  const capMap = new Map(capRows.map((r) => [r.userId, r.creditCap]));

  const members: MemberUsage[] = rows.map((row) => ({
    userId: row.userId,
    email: emailMap.get(row.userId) ?? "unknown",
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheReadInputTokens: Number(row.cacheReadInputTokens),
    cacheCreationInputTokens: Number(row.cacheCreationInputTokens),
    creditsCharged: Number(row.creditsCharged),
    creditCap: capMap.get(row.userId) ?? null,
  }));

  // Sort by credits charged descending
  members.sort((a, b) => b.creditsCharged - a.creditsCharged);

  return {
    period: {
      start: billingPeriod.start.toISOString(),
      end: billingPeriod.end.toISOString(),
    },
    members,
  };
}
