import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";
import {
  queryLegacyAgentBuckets,
  queryLegacyChannelTotals,
  queryLegacyGrandTotal,
  queryLegacySourceBuckets,
  queryLegacyTopChats,
  queryLegacyTopSchedules,
  type UsageInsightBucketRow,
  type UsageInsightSqlParams,
} from "./usage-insight-legacy-ledger";

interface UsageInsightOptions {
  range: "today" | "yesterday" | "7d" | "28d";
  groupBy: "source" | "agent";
  tz: string;
}

export function startOfDayInTz(date: Date, tz: string): Date {
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = parseInt(
    timeParts.find((p) => {
      return p.type === "hour";
    })?.value ?? "0",
  );
  const minute = parseInt(
    timeParts.find((p) => {
      return p.type === "minute";
    })?.value ?? "0",
  );
  const second = parseInt(
    timeParts.find((p) => {
      return p.type === "second";
    })?.value ?? "0",
  );

  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const targetYear = parseInt(
    dateParts.find((p) => {
      return p.type === "year";
    })?.value ?? "0",
  );
  const targetMonth = parseInt(
    dateParts.find((p) => {
      return p.type === "month";
    })?.value ?? "1",
  );
  const targetDay = parseInt(
    dateParts.find((p) => {
      return p.type === "day";
    })?.value ?? "1",
  );

  const elapsed = ((hour * 60 + minute) * 60 + second) * 1000;
  let result = new Date(date.getTime() - elapsed);

  const verify = (d: Date): boolean => {
    const dp = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const y = parseInt(
      dp.find((p) => {
        return p.type === "year";
      })?.value ?? "0",
    );
    const m = parseInt(
      dp.find((p) => {
        return p.type === "month";
      })?.value ?? "1",
    );
    const day = parseInt(
      dp.find((p) => {
        return p.type === "day";
      })?.value ?? "1",
    );
    const h = parseInt(
      dp.find((p) => {
        return p.type === "hour";
      })?.value ?? "0",
    );
    const min = parseInt(
      dp.find((p) => {
        return p.type === "minute";
      })?.value ?? "0",
    );
    const s = parseInt(
      dp.find((p) => {
        return p.type === "second";
      })?.value ?? "0",
    );
    return (
      y === targetYear &&
      m === targetMonth &&
      day === targetDay &&
      h === 0 &&
      min === 0 &&
      s === 0
    );
  };

  if (!verify(result)) {
    const baseTime = result.getTime();
    for (const delta of [3600000, -3600000, 7200000, -7200000]) {
      const candidate = new Date(baseTime + delta);
      if (verify(candidate)) {
        result = candidate;
        break;
      }
    }
  }

  return result;
}

function rangeToWindow(
  range: "today" | "yesterday" | "7d" | "28d",
  tz: string,
): { trunc: string; startTs: Date; endTs: Date } {
  const now = new Date();
  const todayStart = startOfDayInTz(now, tz);

  switch (range) {
    case "today":
      return { trunc: "hour", startTs: todayStart, endTs: now };
    case "yesterday": {
      const yesterdayStart = new Date(todayStart.getTime() - 86400000);
      return { trunc: "hour", startTs: yesterdayStart, endTs: todayStart };
    }
    case "7d": {
      const start = new Date(todayStart.getTime() - 6 * 86400000);
      return { trunc: "day", startTs: start, endTs: now };
    }
    case "28d": {
      const start = new Date(todayStart.getTime() - 27 * 86400000);
      return { trunc: "day", startTs: start, endTs: now };
    }
  }
}

/**
 * Escape a string value as a PostgreSQL single-quoted literal.
 * Doubles any single quotes inside to prevent injection.
 */
function pgLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function pivotBucketRows(
  rows: UsageInsightBucketRow[],
): UsageInsightResponse["buckets"] {
  const bucketMap = new Map<
    string,
    { series: Record<string, number>; tokens: Record<string, number> }
  >();
  for (const row of rows) {
    const tsStr =
      row.ts instanceof Date ? row.ts.toISOString() : String(row.ts);
    if (!bucketMap.has(tsStr)) {
      bucketMap.set(tsStr, { series: {}, tokens: {} });
    }
    const entry = bucketMap.get(tsStr)!;
    entry.series[row.bucket] = Number(row.credits);
    entry.tokens[row.bucket] = Number(row.tokens);
  }
  return [...bucketMap.entries()]
    .sort(([a], [b]) => {
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map(([ts, { series, tokens }]) => {
      return { ts, series, tokens };
    });
}

/**
 * Get personal usage insight for a specific user within an org.
 * Self-scoped — only returns data for the given userId.
 */
export async function getUsageInsight(
  userId: string,
  orgId: string,
  options: UsageInsightOptions,
): Promise<UsageInsightResponse> {
  const db = globalThis.services.db;
  const { trunc, startTs, endTs } = rangeToWindow(options.range, options.tz);

  const p: UsageInsightSqlParams = {
    userIdLit: pgLit(userId),
    orgIdLit: pgLit(orgId),
    startTsLit: pgLit(startTs.toISOString()),
    endTsLit: pgLit(endTs.toISOString()),
    truncLit: pgLit(trunc),
    tzLit: pgLit(options.tz),
  };

  const bucketsResult =
    options.groupBy === "source"
      ? await queryLegacySourceBuckets(db, p)
      : await queryLegacyAgentBuckets(db, p);

  const buckets = pivotBucketRows(bucketsResult.rows);
  const { grandTotalCredits, grandTotalTokens } = await queryLegacyGrandTotal(
    db,
    p,
  );
  const { emailCredits, emailTokens, slackCredits, slackTokens } =
    await queryLegacyChannelTotals(db, p);
  const { schedules, scheduleOtherCount, scheduleOtherCredits } =
    await queryLegacyTopSchedules(db, p);
  const { chats, chatOtherCount, chatOtherCredits } = await queryLegacyTopChats(
    db,
    p,
  );

  return {
    buckets,
    schedules,
    scheduleOtherCount,
    scheduleOtherCredits,
    chats,
    chatOtherCount,
    chatOtherCredits,
    emailCredits,
    emailTokens,
    slackCredits,
    slackTokens,
    grandTotalCredits,
    grandTotalTokens,
  };
}
