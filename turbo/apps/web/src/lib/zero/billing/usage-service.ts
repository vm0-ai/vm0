import { and, eq, inArray } from "drizzle-orm";
import {
  type MemberUsage,
  type UsageMembersResponse,
} from "@vm0/api-contracts/contracts/zero-usage";
import { getOrgBillingPeriod } from "../org/org-metadata-service";
import { userCache } from "@vm0/db/schema/user-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { clerkClient } from "@clerk/nextjs/server";
import { getMemberUsageTotals } from "./usage-reporting-ledger";

/**
 * Get per-member token usage aggregation for the current billing period.
 * Includes processed usage_event records.
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

  const rows = await getMemberUsageTotals(db, orgId, billingPeriod);

  if (rows.length === 0) {
    return {
      period: {
        start: billingPeriod.start.toISOString(),
        end: billingPeriod.end.toISOString(),
      },
      members: [],
    };
  }

  // Resolve user emails
  const userIds = rows.map((r) => {
    return r.userId;
  });
  const emailMap = await resolveEmails(userIds);

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
  const capMap = new Map(
    capRows.map((r) => {
      return [r.userId, r.creditCap];
    }),
  );

  const members: MemberUsage[] = rows.map((row) => {
    return {
      userId: row.userId,
      email: emailMap.get(row.userId) ?? "unknown",
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheReadInputTokens: Number(row.cacheReadInputTokens),
      cacheCreationInputTokens: Number(row.cacheCreationInputTokens),
      creditsCharged: Number(row.creditsCharged),
      creditCap: capMap.get(row.userId) ?? null,
    };
  });

  // Sort by credits charged descending
  members.sort((a, b) => {
    return b.creditsCharged - a.creditsCharged;
  });

  return {
    period: {
      start: billingPeriod.start.toISOString(),
      end: billingPeriod.end.toISOString(),
    },
    members,
  };
}

/**
 * Resolve emails for a set of user IDs using user_cache + Clerk fallback.
 */
async function resolveEmails(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const db = globalThis.services.db;
  const cachedUsers = await db
    .select({ userId: userCache.userId, email: userCache.email })
    .from(userCache)
    .where(inArray(userCache.userId, userIds));

  const emailMap = new Map(
    cachedUsers.map((u) => {
      return [u.userId, u.email];
    }),
  );

  const missingIds = userIds.filter((id) => {
    return !emailMap.has(id);
  });
  if (missingIds.length > 0) {
    const client = await clerkClient();
    const clerkUsers = await client.users.getUserList({
      userId: missingIds,
      limit: missingIds.length,
    });

    const now = new Date();
    for (const user of clerkUsers.data) {
      const primaryEmail = user.emailAddresses.find((e) => {
        return e.id === user.primaryEmailAddressId;
      });
      const email = primaryEmail?.emailAddress ?? "unknown";
      emailMap.set(user.id, email);

      await db
        .insert(userCache)
        .values({ userId: user.id, email, cachedAt: now })
        .onConflictDoUpdate({
          target: userCache.userId,
          set: { email, cachedAt: now },
        });
    }
  }

  return emailMap;
}
