import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";
import {
  queryUsageInsightAgentBuckets,
  queryUsageInsightChannelTotals,
  queryUsageInsightGrandTotal,
  queryUsageInsightSourceBuckets,
  queryUsageInsightTopChats,
  queryUsageInsightTopSchedules,
  type UsageInsightBucketRow,
  type UsageInsightSqlParams,
} from "./usage-insight-ledger";

interface UsageInsightOptions {
  range: "today" | "yesterday" | "day" | "7d" | "28d" | "30d";
  date?: string;
  groupBy: "source" | "agent";
  tz: string;
}

interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInTz(date: Date, tz: string): TimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => {
    return Number(
      parts.find((part) => {
        return part.type === type;
      })?.value ?? 0,
    );
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function startOfCalendarDateInTz(isoDate: string, tz: string): Date {
  const [yearPart, monthPart, dayPart] = isoDate.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;

  for (let i = 0; i < 4; i++) {
    const parts = partsInTz(new Date(guess), tz);
    const actual = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const delta = actual - target;
    if (delta === 0) {
      return new Date(guess);
    }
    guess -= delta;
  }

  return new Date(guess);
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
  range: UsageInsightOptions["range"],
  tz: string,
  date?: string,
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
    case "day": {
      if (!date) {
        throw new Error("date is required when range=day");
      }
      const start = startOfCalendarDateInTz(date, tz);
      const end = new Date(start.getTime() + 86400000);
      return { trunc: "hour", startTs: start, endTs: end };
    }
    case "7d": {
      const start = new Date(todayStart.getTime() - 6 * 86400000);
      return { trunc: "day", startTs: start, endTs: now };
    }
    case "28d": {
      const start = new Date(todayStart.getTime() - 27 * 86400000);
      return { trunc: "day", startTs: start, endTs: now };
    }
    case "30d": {
      const start = new Date(todayStart.getTime() - 29 * 86400000);
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
  const { trunc, startTs, endTs } = rangeToWindow(
    options.range,
    options.tz,
    options.date,
  );

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
      ? await queryUsageInsightSourceBuckets(db, p)
      : await queryUsageInsightAgentBuckets(db, p);

  const buckets = pivotBucketRows(bucketsResult.rows);
  const { grandTotalCredits, grandTotalTokens } =
    await queryUsageInsightGrandTotal(db, p);
  const { emailCredits, emailTokens, slackCredits, slackTokens } =
    await queryUsageInsightChannelTotals(db, p);
  const { schedules, scheduleOtherCount, scheduleOtherCredits } =
    await queryUsageInsightTopSchedules(db, p);
  const { chats, chatOtherCount, chatOtherCredits } =
    await queryUsageInsightTopChats(db, p);

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
