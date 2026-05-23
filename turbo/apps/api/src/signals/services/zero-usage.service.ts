import { command } from "ccstate";
import { and, count, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type {
  MemberUsage,
  UsageMembersResponse,
} from "@vm0/api-contracts/contracts/zero-usage";
import type { UsageRunsResponse } from "@vm0/api-contracts/contracts/zero-usage-daily";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import type { User } from "@clerk/backend";

import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { getOrgBillingPeriod$ } from "./zero-org-billing-period.service";
import {
  buildUsageEventRunUsageTotalsSubquery,
  getMemberUsageTotals,
  hasRunUsageTotals,
  mergedRunCacheTokens,
  mergedRunCreditsCharged,
  mergedRunInputTokens,
  mergedRunModel,
  mergedRunOutputTokens,
} from "./zero-usage-reporting-ledger";

interface UsageMembersArgs {
  readonly orgId: string;
}

export const zeroUsageMembers$ = command(
  async (
    { get, set },
    args: UsageMembersArgs,
    signal: AbortSignal,
  ): Promise<UsageMembersResponse> => {
    const billingPeriod = await set(getOrgBillingPeriod$, args.orgId, signal);
    signal.throwIfAborted();

    if (!billingPeriod) {
      return { period: null, members: [] };
    }

    const db = set(writeDb$);
    const rows = await getMemberUsageTotals(db, args.orgId, billingPeriod);
    signal.throwIfAborted();

    if (rows.length === 0) {
      return {
        period: {
          start: billingPeriod.start.toISOString(),
          end: billingPeriod.end.toISOString(),
        },
        members: [],
      };
    }

    const userIds = rows.map((row) => {
      return row.userId;
    });
    const emailMap = await resolveEmails(get(clerk$), db, userIds, signal);

    const members: MemberUsage[] = rows.map((row) => {
      return {
        userId: row.userId,
        email: emailMap.get(row.userId) ?? "unknown",
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cacheReadInputTokens: Number(row.cacheReadInputTokens),
        cacheCreationInputTokens: Number(row.cacheCreationInputTokens),
        creditsCharged: Number(row.creditsCharged),
      };
    });

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
  },
);

interface UsageRunsArgs {
  readonly orgId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly agentId?: string;
  readonly userIds?: readonly string[];
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

export const zeroUsageRuns$ = command(
  async (
    { get, set },
    args: UsageRunsArgs,
    signal: AbortSignal,
  ): Promise<UsageRunsResponse> => {
    const db = set(writeDb$);
    const eventUsage = buildUsageEventRunUsageTotalsSubquery(db, args.orgId);
    const conditions = [eq(agentRuns.orgId, args.orgId)];

    if (args.agentId) {
      conditions.push(eq(agentComposes.id, args.agentId));
    }
    if (args.userIds && args.userIds.length > 0) {
      conditions.push(inArray(agentRuns.userId, [...args.userIds]));
    }
    if (args.dateFrom) {
      conditions.push(gte(agentRuns.createdAt, new Date(args.dateFrom)));
    }
    if (args.dateTo) {
      conditions.push(lt(agentRuns.createdAt, new Date(args.dateTo)));
    }

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
    signal.throwIfAborted();

    const offset = (args.page - 1) * args.pageSize;
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
      .limit(args.pageSize)
      .offset(offset);
    signal.throwIfAborted();

    const uniqueUserIds = [
      ...new Set(
        rows.map((row) => {
          return row.userId;
        }),
      ),
    ];
    const emailMap = await resolveEmails(
      get(clerk$),
      db,
      uniqueUserIds,
      signal,
    );

    return {
      runs: rows.map((row) => {
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
      }),
      pagination: {
        page: args.page,
        pageSize: args.pageSize,
        total: countResult?.total ?? 0,
      },
    };
  },
);

type ClerkClient = ReturnType<typeof clerk$.read>;
type WriteDb = ReturnType<typeof writeDb$.write>;

function primaryEmail(user: User): string {
  const primary = user.emailAddresses.find((email) => {
    return email.id === user.primaryEmailAddressId;
  });
  return primary?.emailAddress ?? "unknown";
}

async function resolveEmails(
  client: ClerkClient,
  db: WriteDb,
  userIds: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const cachedUsers = await db
    .select({ userId: userCache.userId, email: userCache.email })
    .from(userCache)
    .where(inArray(userCache.userId, [...userIds]));
  signal.throwIfAborted();

  const emailMap = new Map(
    cachedUsers.map((user) => {
      return [user.userId, user.email];
    }),
  );

  const missingIds = userIds.filter((id) => {
    return !emailMap.has(id);
  });
  if (missingIds.length === 0) {
    return emailMap;
  }

  const clerkUsers = await client.users.getUserList({
    userId: [...missingIds],
    limit: missingIds.length,
  });
  signal.throwIfAborted();
  const now = nowDate();

  for (const user of clerkUsers.data) {
    const email = primaryEmail(user);
    emailMap.set(user.id, email);
    await db
      .insert(userCache)
      .values({ userId: user.id, email, cachedAt: now })
      .onConflictDoUpdate({
        target: userCache.userId,
        set: { email, cachedAt: now },
      });
    signal.throwIfAborted();
  }

  return emailMap;
}
