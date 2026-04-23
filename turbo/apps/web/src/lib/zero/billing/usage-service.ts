import { sql, and, eq, gte, lt, inArray, desc, count } from "drizzle-orm";
import {
  type MemberUsage,
  type UsageMembersResponse,
} from "@vm0/core/contracts/zero-usage";
import type { UsageRunsResponse } from "@vm0/core/contracts/zero-usage-daily";
import { getOrgBillingPeriod } from "../org/org-metadata-service";
import { creditUsage } from "../../../db/schema/credit-usage";
import { agentRuns } from "../../../db/schema/agent-run";
import { zeroRuns } from "../../../db/schema/zero-run";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { zeroAgents } from "../../../db/schema/zero-agent";
import { userCache } from "../../../db/schema/user-cache";
import { orgMembersMetadata } from "../../../db/schema/org-members-metadata";
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
 * Get per-run credit usage records for an org with pagination and filtering.
 * Only includes runs that have processed credit_usage records.
 */
export async function getUsageRuns(
  orgId: string,
  options: UsageRunsOptions,
): Promise<UsageRunsResponse> {
  const db = globalThis.services.db;

  // Subquery: aggregate credit_usage per run_id
  const creditSub = db
    .select({
      runId: creditUsage.runId,
      inputTokens:
        sql<number>`COALESCE(SUM(${creditUsage.inputTokens}), 0)::bigint`.as(
          "input_tokens_sum",
        ),
      outputTokens:
        sql<number>`COALESCE(SUM(${creditUsage.outputTokens}), 0)::bigint`.as(
          "output_tokens_sum",
        ),
      cacheTokens:
        sql<number>`COALESCE(SUM(${creditUsage.cacheReadInputTokens}) + SUM(${creditUsage.cacheCreationInputTokens}), 0)::bigint`.as(
          "cache_tokens_sum",
        ),
      creditsCharged:
        sql<number>`COALESCE(SUM(${creditUsage.creditsCharged}), 0)::bigint`.as(
          "credits_sum",
        ),
      model: sql<string>`MAX(${creditUsage.model})`.as("model"),
      userId: sql<string>`MAX(${creditUsage.userId})`.as("cu_user_id"),
    })
    .from(creditUsage)
    .where(
      and(eq(creditUsage.orgId, orgId), eq(creditUsage.status, "processed")),
    )
    .groupBy(creditUsage.runId)
    .as("credit_sub");

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
    .innerJoin(creditSub, eq(agentRuns.id, creditSub.runId))
    .leftJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposeVersions.composeId, agentComposes.id),
    )
    .where(and(...conditions));

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
      inputTokens: creditSub.inputTokens,
      outputTokens: creditSub.outputTokens,
      cacheTokens: creditSub.cacheTokens,
      creditsCharged: creditSub.creditsCharged,
      model: creditSub.model,
    })
    .from(agentRuns)
    .innerJoin(creditSub, eq(agentRuns.id, creditSub.runId))
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
    .where(and(...conditions))
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
