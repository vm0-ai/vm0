import { and, eq, gte, lt, inArray, desc, count } from "drizzle-orm";
import {
  type MemberUsage,
  type UsageMembersResponse,
} from "@vm0/api-contracts/contracts/zero-usage";
import type { UsageRunsResponse } from "@vm0/api-contracts/contracts/zero-usage-daily";
import { getOrgBillingPeriod } from "../org/org-metadata-service";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { userCache } from "@vm0/db/schema/user-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { clerkClient } from "@clerk/nextjs/server";
import {
  buildUsageEventRunUsageTotalsSubquery,
  getMemberUsageTotals,
  hasRunUsageTotals,
  mergedRunCacheTokens,
  mergedRunCreditsCharged,
  mergedRunInputTokens,
  mergedRunModel,
  mergedRunOutputTokens,
} from "./usage-reporting-ledger";

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

interface UsageRunsOptions {
  page: number;
  pageSize: number;
  agentId?: string;
  userIds?: string[];
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Get per-run usage records for an org with pagination and filtering.
 * Includes runs with processed run-linked usage_event records.
 */
export async function getUsageRuns(
  orgId: string,
  options: UsageRunsOptions,
): Promise<UsageRunsResponse> {
  const db = globalThis.services.db;

  const eventUsage = buildUsageEventRunUsageTotalsSubquery(db, orgId);

  // Build filter conditions
  const conditions = [eq(agentRuns.orgId, orgId)];

  if (options.agentId) {
    conditions.push(eq(agentComposes.id, options.agentId));
  }
  if (options.userIds && options.userIds.length > 0) {
    conditions.push(inArray(agentRuns.userId, options.userIds));
  }
  if (options.dateFrom) {
    conditions.push(gte(agentRuns.createdAt, new Date(options.dateFrom)));
  }
  if (options.dateTo) {
    conditions.push(lt(agentRuns.createdAt, new Date(options.dateTo)));
  }

  // Count query
  const [countResult] = await db
    .select({ total: count() })
    .from(agentRuns)
    .leftJoin(eventUsage, eq(agentRuns.id, eventUsage.runId))
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(and(...conditions, hasRunUsageTotals(eventUsage)));

  const total = countResult?.total ?? 0;

  // Data query with pagination
  const offset = (options.page - 1) * options.pageSize;

  const rows = await db
    .select({
      runId: agentRuns.id,
      status: agentRuns.status,
      createdAt: agentRuns.createdAt,
      startedAt: agentRuns.startedAt,
      completedAt: agentRuns.completedAt,
      userId: agentRuns.userId,
      prompt: agentRuns.prompt,
      triggerSource: zeroRuns.triggerSource,
      agentName: zeroAgents.displayName,
      inputTokens: mergedRunInputTokens(eventUsage),
      outputTokens: mergedRunOutputTokens(eventUsage),
      cacheTokens: mergedRunCacheTokens(eventUsage),
      creditsCharged: mergedRunCreditsCharged(eventUsage),
      model: mergedRunModel(eventUsage),
    })
    .from(agentRuns)
    .leftJoin(eventUsage, eq(agentRuns.id, eventUsage.runId))
    .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(and(...conditions, hasRunUsageTotals(eventUsage)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(options.pageSize)
    .offset(offset);

  // Resolve emails
  const uniqueUserIds = [
    ...new Set(
      rows.map((r) => {
        return r.userId;
      }),
    ),
  ];
  const emailMap = await resolveEmails(uniqueUserIds);

  const runs = rows.map((row) => {
    const startedAt = row.startedAt?.toISOString() ?? null;
    const completedAt = row.completedAt?.toISOString() ?? null;
    const durationMs =
      row.startedAt && row.completedAt
        ? row.completedAt.getTime() - row.startedAt.getTime()
        : null;

    return {
      runId: row.runId,
      agentName: row.agentName ?? null,
      memberEmail: emailMap.get(row.userId) ?? "unknown",
      userId: row.userId,
      triggerSource: row.triggerSource ?? null,
      model: row.model ?? "unknown",
      status: row.status,
      prompt: row.prompt,
      startedAt,
      completedAt,
      durationMs,
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cacheTokens: Number(row.cacheTokens),
      creditsCharged: Number(row.creditsCharged),
      createdAt: row.createdAt.toISOString(),
    };
  });

  return {
    runs,
    pagination: {
      page: options.page,
      pageSize: options.pageSize,
      total,
    },
  };
}
