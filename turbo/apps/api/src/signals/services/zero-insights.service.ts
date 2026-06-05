import { computed, type Computed } from "ccstate";
import type {
  DayInsight,
  InsightsRangeResponse,
  InsightsResponse,
} from "@vm0/api-contracts/contracts/zero-insights";
import { insightsDaily } from "@vm0/db/schema/insights-daily";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { and, desc, eq, gte, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { db$ } from "../external/db";
import { settle } from "../utils";

type DayInsightData = Partial<Omit<DayInsight, "date">>;
const ORG_MEMBERSHIP_PAGE_SIZE = 100;

interface StoredTeamUsageEntry {
  readonly userId?: string;
  readonly name: string;
  readonly credits: number;
  readonly agentNames?: string[];
  readonly agentCredits?: Record<string, number>;
}

type StoredDayInsightData = DayInsightData & {
  readonly teamUsage?: readonly StoredTeamUsageEntry[];
};

interface ClerkOrganizationMembership {
  readonly publicUserData?: {
    readonly userId?: string | null;
  } | null;
}

interface ClerkOrganizationsLike {
  readonly getOrganizationMembershipList: (args: {
    readonly organizationId: string;
    readonly limit: number;
    readonly offset: number;
  }) => Promise<{ readonly data: readonly ClerkOrganizationMembership[] }>;
}

function normalizeDays(days: number | undefined): number {
  return Math.min(Math.max(days ?? 30, 1), 90);
}

function cutoffDateIso(days: number): string {
  const cutoff = nowDate();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff.toISOString().split("T")[0]!;
}

function filterTeamUsageByCurrentMembers(
  teamUsage: readonly StoredTeamUsageEntry[],
  currentMemberUserIds: Set<string> | null,
): StoredTeamUsageEntry[] {
  if (!currentMemberUserIds) {
    return [...teamUsage];
  }

  return teamUsage.filter((member) => {
    return !member.userId || currentMemberUserIds.has(member.userId);
  });
}

async function queryCurrentOrgMemberUserIds(
  organizations: ClerkOrganizationsLike,
  orgId: string,
): Promise<Set<string> | null> {
  const userIds = new Set<string>();
  for (let offset = 0; ; offset += ORG_MEMBERSHIP_PAGE_SIZE) {
    const result = await settle(
      organizations.getOrganizationMembershipList({
        organizationId: orgId,
        limit: ORG_MEMBERSHIP_PAGE_SIZE,
        offset,
      }),
    );
    if (!result.ok) {
      return null;
    }

    for (const membership of result.value.data) {
      const userId = membership.publicUserData?.userId;
      if (userId) {
        userIds.add(userId);
      }
    }

    if (result.value.data.length < ORG_MEMBERSHIP_PAGE_SIZE) {
      return userIds;
    }
  }
}

export function zeroInsights(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly days: number | undefined;
}): Computed<Promise<InsightsResponse>> {
  return computed(async (get): Promise<InsightsResponse> => {
    const db = get(db$);
    const memberRows = await db
      .select({ userId: orgMembersCache.userId })
      .from(orgMembersCache)
      .where(eq(orgMembersCache.orgId, args.orgId));
    const currentMemberUserIds =
      memberRows.length > 0
        ? await queryCurrentOrgMemberUserIds(
            get(clerk$).organizations,
            args.orgId,
          )
        : null;

    const rows = await db
      .select({
        date: insightsDaily.date,
        data: insightsDaily.data,
        updatedAt: insightsDaily.updatedAt,
      })
      .from(insightsDaily)
      .where(
        and(
          eq(insightsDaily.orgId, args.orgId),
          eq(insightsDaily.userId, args.userId),
          gte(
            insightsDaily.date,
            sql`${cutoffDateIso(normalizeDays(args.days))}::date`,
          ),
        ),
      )
      .orderBy(desc(insightsDaily.date));

    const days = rows.map((row): DayInsight => {
      const data = row.data as StoredDayInsightData;
      const teamUsage = filterTeamUsageByCurrentMembers(
        data.teamUsage ?? [],
        currentMemberUserIds,
      );
      const creditsUsed =
        currentMemberUserIds && data.teamUsage
          ? teamUsage.reduce((sum, member) => {
              return sum + member.credits;
            }, 0)
          : (data.creditsUsed ?? 0);
      return {
        date: row.date,
        agents: data.agents ?? [],
        creditsUsed,
        creditBalance: data.creditBalance ?? 0,
        teamUsage,
        topTask: data.topTask ?? null,
        services: data.services ?? [],
        permissions: data.permissions ?? [],
        schedules: data.schedules ?? [],
        chats: data.chats ?? [],
      };
    });

    const totalCredits = days.reduce((sum, day) => {
      return sum + day.creditsUsed;
    }, 0);
    const totalRuns = days.reduce((sum, day) => {
      return (
        sum +
        day.agents.reduce((agentSum, agent) => {
          return agentSum + agent.runs;
        }, 0)
      );
    }, 0);

    const lastUpdated =
      rows.length > 0
        ? rows.reduce((latest, row) => {
            return row.updatedAt > latest ? row.updatedAt : latest;
          }, rows[0]!.updatedAt)
        : null;

    return {
      days,
      totalCredits,
      totalRuns,
      lastUpdated: lastUpdated?.toISOString() ?? null,
    };
  });
}

export function zeroInsightsRange(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<InsightsRangeResponse>> {
  return computed(async (get): Promise<InsightsRangeResponse> => {
    const [row] = await get(db$)
      .select({
        minDate: sql<string | null>`MIN(${insightsDaily.date})`.as("min_date"),
        maxDate: sql<string | null>`MAX(${insightsDaily.date})`.as("max_date"),
        totalDays: sql<number>`COUNT(*)::int`.as("total_days"),
      })
      .from(insightsDaily)
      .where(
        and(
          eq(insightsDaily.orgId, args.orgId),
          eq(insightsDaily.userId, args.userId),
        ),
      );

    if (!row || row.totalDays === 0) {
      return { minDate: null, maxDate: null, totalDays: 0 };
    }

    return {
      minDate: row.minDate,
      maxDate: row.maxDate,
      totalDays: row.totalDays,
    };
  });
}
