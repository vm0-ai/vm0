import { command } from "ccstate";
import type {
  UsageInsightBucket,
  UsageInsightChatRow,
  UsageInsightResponse,
} from "@vm0/api-contracts/contracts/zero-usage-insight";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { usageEventHourlyRollup } from "@vm0/db/schema/usage-event-hourly-rollup";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  sql,
  sum,
  type SQLWrapper,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  buildFinalizedUsageRelation,
  type FinalizedUsageRelation,
} from "./finalized-usage-relation";
import { normalizeFinalizedUsagePeriod } from "./finalized-usage-time";

const MODEL_USAGE_KIND = "model";
const MODEL_TOKEN_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;
const CHANNEL_SOURCES = ["email", "slack"] as const;
const channelSourceDecoder = zodEnumDriverValueDecoder(z.enum(CHANNEL_SOURCES));

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

interface UsageInsightSqlParams {
  readonly userId: string;
  readonly orgId: string;
  readonly startTs: Date;
  readonly endTs: Date;
  readonly trunc: "hour" | "day";
  readonly tz: string;
}

interface UsageInsightBucketRow {
  readonly ts: Date;
  readonly bucket: string;
  readonly credits: number;
  readonly tokens: number;
}

interface UsageInsightArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly options: UsageInsightOptions;
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
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
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

function startOfDayInTz(date: Date, tz: string): Date {
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number.parseInt(
    timeParts.find((part) => {
      return part.type === "hour";
    })?.value ?? "0",
    10,
  );
  const minute = Number.parseInt(
    timeParts.find((part) => {
      return part.type === "minute";
    })?.value ?? "0",
    10,
  );
  const second = Number.parseInt(
    timeParts.find((part) => {
      return part.type === "second";
    })?.value ?? "0",
    10,
  );

  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const targetYear = Number.parseInt(
    dateParts.find((part) => {
      return part.type === "year";
    })?.value ?? "0",
    10,
  );
  const targetMonth = Number.parseInt(
    dateParts.find((part) => {
      return part.type === "month";
    })?.value ?? "1",
    10,
  );
  const targetDay = Number.parseInt(
    dateParts.find((part) => {
      return part.type === "day";
    })?.value ?? "1",
    10,
  );

  const elapsed = ((hour * 60 + minute) * 60 + second) * 1000;
  let result = new Date(date.getTime() - elapsed);

  const verify = (candidate: Date): boolean => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(candidate);
    const year = Number.parseInt(
      parts.find((part) => {
        return part.type === "year";
      })?.value ?? "0",
      10,
    );
    const month = Number.parseInt(
      parts.find((part) => {
        return part.type === "month";
      })?.value ?? "1",
      10,
    );
    const day = Number.parseInt(
      parts.find((part) => {
        return part.type === "day";
      })?.value ?? "1",
      10,
    );
    const candidateHour = Number.parseInt(
      parts.find((part) => {
        return part.type === "hour";
      })?.value ?? "0",
      10,
    );
    const candidateMinute = Number.parseInt(
      parts.find((part) => {
        return part.type === "minute";
      })?.value ?? "0",
      10,
    );
    const candidateSecond = Number.parseInt(
      parts.find((part) => {
        return part.type === "second";
      })?.value ?? "0",
      10,
    );
    return (
      year === targetYear &&
      month === targetMonth &&
      day === targetDay &&
      candidateHour === 0 &&
      candidateMinute === 0 &&
      candidateSecond === 0
    );
  };

  if (!verify(result)) {
    const baseTime = result.getTime();
    for (const delta of [3_600_000, -3_600_000, 7_200_000, -7_200_000]) {
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
  date: string | undefined,
): { trunc: "hour" | "day"; startTs: Date; endTs: Date } {
  const now = nowDate();
  const todayStart = startOfDayInTz(now, tz);

  switch (range) {
    case "today": {
      return { trunc: "hour", startTs: todayStart, endTs: now };
    }
    case "yesterday": {
      const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);
      return { trunc: "hour", startTs: yesterdayStart, endTs: todayStart };
    }
    case "day": {
      if (!date) {
        throw new Error("date is required when range=day");
      }
      const start = startOfCalendarDateInTz(date, tz);
      const end = new Date(start.getTime() + 86_400_000);
      return { trunc: "hour", startTs: start, endTs: end };
    }
    case "7d": {
      const start = new Date(todayStart.getTime() - 6 * 86_400_000);
      return { trunc: "day", startTs: start, endTs: now };
    }
    case "28d": {
      const start = new Date(todayStart.getTime() - 27 * 86_400_000);
      return { trunc: "day", startTs: start, endTs: now };
    }
    case "30d": {
      const start = new Date(todayStart.getTime() - 29 * 86_400_000);
      return { trunc: "day", startTs: start, endTs: now };
    }
  }
}

function usageBucketExpr(activityTime: SQLWrapper, p: UsageInsightSqlParams) {
  return sql`date_trunc(${p.trunc}, ${activityTime} AT TIME ZONE 'UTC' AT TIME ZONE ${p.tz})`.mapWith(
    usageEventHourlyRollup.processedHour,
  );
}

function usageRowTokenExpr(usage: FinalizedUsageRelation) {
  return sql`CASE
    WHEN ${and(
      eq(usage.kind, MODEL_USAGE_KIND),
      inArray(usage.category, MODEL_TOKEN_CATEGORIES),
    )}
    THEN ${usage.quantity}
    ELSE 0
  END::bigint`.mapWith(pgInt8ToSafeIntegerDecoder);
}

function usageCreditsExpr(usage: FinalizedUsageRelation) {
  return sql`${usage.creditsCharged} + ${usage.allowanceUnits}::bigint`.mapWith(
    pgInt8ToSafeIntegerDecoder,
  );
}

function usageRowsCte(db: Db, p: UsageInsightSqlParams) {
  const usage = buildFinalizedUsageRelation({
    start: p.startTs,
    end: p.endTs,
  });
  return db.$with("usage_rows").as(
    db
      .select({
        activityTime: usage.processedHour,
        runId: usage.runId,
        userId: usage.userId,
        orgId: usage.orgId,
        creditsCharged: usageCreditsExpr(usage).as("credits_charged"),
        tokens: usageRowTokenExpr(usage).as("tokens"),
      })
      .from(usage)
      .where(and(eq(usage.userId, p.userId), eq(usage.orgId, p.orgId))),
  );
}

function safeIntegerSum(value: SQLWrapper) {
  return sql`COALESCE(${sum(value)}, 0)::bigint`.mapWith(
    pgInt8ToSafeIntegerDecoder,
  );
}

function sourceBucketExpr() {
  return sql`CASE
    WHEN ${eq(zeroRuns.triggerSource, "web")} THEN 'chat'
    WHEN ${eq(zeroRuns.triggerSource, "slack")} THEN 'slack'
    WHEN ${eq(zeroRuns.triggerSource, "email")} THEN 'email'
    WHEN ${inArray(zeroRuns.triggerSource, [
      "workflow-schedule",
      "workflow-event",
    ])} THEN 'automation'
    ELSE 'others'
  END`.mapWith(pgTextDecoder);
}

function agentNameExpr() {
  return sql`CASE
    WHEN ${isNull(agentRuns.id)} THEN 'others'
    ELSE COALESCE(
      ${zeroAgents.displayName},
      ${zeroAgents.name},
      ${agentComposes.name},
      'unknown'
    )
  END`.mapWith(pgTextDecoder);
}

function chatRankExpr(credits: SQLWrapper, stableKey: SQLWrapper) {
  return sql`ROW_NUMBER() OVER (
    ORDER BY ${desc(sum(credits))} NULLS LAST, ${stableKey} ASC
  )`.mapWith(pgInt8ToSafeIntegerDecoder);
}

function pivotBucketRows(
  rows: readonly UsageInsightBucketRow[],
): UsageInsightBucket[] {
  const bucketMap = new Map<
    string,
    { series: Record<string, number>; tokens: Record<string, number> }
  >();
  for (const row of rows) {
    const tsStr = row.ts.toISOString();
    if (!bucketMap.has(tsStr)) {
      bucketMap.set(tsStr, { series: {}, tokens: {} });
    }
    const entry = bucketMap.get(tsStr);
    if (!entry) {
      continue;
    }
    entry.series[row.bucket] = row.credits;
    entry.tokens[row.bucket] = row.tokens;
  }
  return [...bucketMap.entries()]
    .sort(([a], [b]) => {
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map(([ts, { series, tokens }]) => {
      return { ts, series, tokens };
    });
}

async function queryUsageInsightSourceBuckets(
  db: Db,
  p: UsageInsightSqlParams,
): Promise<UsageInsightBucketRow[]> {
  const usageRows = usageRowsCte(db, p);
  return await db
    .with(usageRows)
    .select({
      ts: usageBucketExpr(usageRows.activityTime, p).as("ts"),
      bucket: sourceBucketExpr().as("bucket"),
      credits: safeIntegerSum(usageRows.creditsCharged).as("credits"),
      tokens: safeIntegerSum(usageRows.tokens).as("tokens"),
    })
    .from(usageRows)
    .leftJoin(zeroRuns, eq(zeroRuns.id, usageRows.runId))
    .groupBy(({ bucket, ts }) => {
      return [ts, bucket];
    })
    .orderBy(({ ts }) => {
      return ts;
    });
}

async function queryUsageInsightAgentBuckets(
  db: Db,
  p: UsageInsightSqlParams,
): Promise<UsageInsightBucketRow[]> {
  const usageRows = usageRowsCte(db, p);
  const agentTotals = db.$with("agent_totals").as(
    db
      .select({
        agentName: agentNameExpr().as("agent_name"),
        totalCredits: safeIntegerSum(usageRows.creditsCharged).as(
          "total_credits",
        ),
      })
      .from(usageRows)
      .leftJoin(agentRuns, eq(agentRuns.id, usageRows.runId))
      .leftJoin(
        agentComposeVersions,
        eq(agentComposeVersions.id, agentRuns.agentComposeVersionId),
      )
      .leftJoin(
        agentComposes,
        eq(agentComposes.id, agentComposeVersions.composeId),
      )
      .leftJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
      .groupBy(({ agentName }) => {
        return agentName;
      }),
  );
  const topSeven = db
    .$with("top7")
    .as(
      db
        .select({ agentName: agentTotals.agentName })
        .from(agentTotals)
        .orderBy(desc(agentTotals.totalCredits), agentTotals.agentName)
        .limit(7),
    );
  const agentName = agentNameExpr();
  const bucket = sql`CASE
    WHEN ${inArray(
      agentName,
      db.select({ agentName: topSeven.agentName }).from(topSeven),
    )}
    THEN ${agentName}
    ELSE 'others'
  END`.mapWith(pgTextDecoder);

  return await db
    .with(usageRows, agentTotals, topSeven)
    .select({
      ts: usageBucketExpr(usageRows.activityTime, p).as("ts"),
      bucket: bucket.as("bucket"),
      credits: safeIntegerSum(usageRows.creditsCharged).as("credits"),
      tokens: safeIntegerSum(usageRows.tokens).as("tokens"),
    })
    .from(usageRows)
    .leftJoin(agentRuns, eq(agentRuns.id, usageRows.runId))
    .leftJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentRuns.agentComposeVersionId),
    )
    .leftJoin(
      agentComposes,
      eq(agentComposes.id, agentComposeVersions.composeId),
    )
    .leftJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .groupBy(({ bucket: selectedBucket, ts }) => {
      return [ts, selectedBucket];
    })
    .orderBy(({ ts }) => {
      return ts;
    });
}

async function queryUsageInsightGrandTotal(
  db: Db,
  p: UsageInsightSqlParams,
): Promise<{ grandTotalCredits: number; grandTotalTokens: number }> {
  const usageRows = usageRowsCte(db, p);
  const rows = await db
    .with(usageRows)
    .select({
      grandCredits: safeIntegerSum(usageRows.creditsCharged).as(
        "grand_credits",
      ),
      grandTokens: safeIntegerSum(usageRows.tokens).as("grand_tokens"),
    })
    .from(usageRows);
  return {
    grandTotalCredits: rows[0]?.grandCredits ?? 0,
    grandTotalTokens: rows[0]?.grandTokens ?? 0,
  };
}

async function queryUsageInsightChannelTotals(
  db: Db,
  p: UsageInsightSqlParams,
): Promise<{
  emailCredits: number;
  emailTokens: number;
  slackCredits: number;
  slackTokens: number;
}> {
  const usageRows = usageRowsCte(db, p);
  const rows = await db
    .with(usageRows)
    .select({
      source: sql`${zeroRuns.triggerSource}`
        .mapWith(channelSourceDecoder)
        .as("source"),
      credits: safeIntegerSum(usageRows.creditsCharged).as("credits"),
      tokens: safeIntegerSum(usageRows.tokens).as("tokens"),
    })
    .from(usageRows)
    .leftJoin(zeroRuns, eq(zeroRuns.id, usageRows.runId))
    .where(inArray(zeroRuns.triggerSource, CHANNEL_SOURCES))
    .groupBy(zeroRuns.triggerSource);
  let emailCredits = 0;
  let emailTokens = 0;
  let slackCredits = 0;
  let slackTokens = 0;
  for (const row of rows) {
    if (row.source === "email") {
      emailCredits = row.credits;
      emailTokens = row.tokens;
    } else {
      slackCredits = row.credits;
      slackTokens = row.tokens;
    }
  }
  return { emailCredits, emailTokens, slackCredits, slackTokens };
}

async function queryUsageInsightTopChats(
  db: Db,
  p: UsageInsightSqlParams,
): Promise<{
  chats: UsageInsightChatRow[];
  chatOtherCount: number;
  chatOtherCredits: number;
}> {
  const usageRows = usageRowsCte(db, p);
  const aggregateChats = db.$with("agg").as(
    db
      .select({
        threadId: zeroRuns.chatThreadId,
        threadTitle: chatThreads.title,
        credits: safeIntegerSum(usageRows.creditsCharged).as("credits"),
        tokens: safeIntegerSum(usageRows.tokens).as("tokens"),
        rn: chatRankExpr(usageRows.creditsCharged, zeroRuns.chatThreadId).as(
          "rn",
        ),
      })
      .from(usageRows)
      .innerJoin(zeroRuns, eq(zeroRuns.id, usageRows.runId))
      .leftJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
      .where(isNotNull(zeroRuns.chatThreadId))
      .groupBy(zeroRuns.chatThreadId, chatThreads.title),
  );
  const topChatRows = db
    .select({
      threadId: aggregateChats.threadId,
      threadTitle: aggregateChats.threadTitle,
      credits: aggregateChats.credits,
      tokens: aggregateChats.tokens,
      rn: aggregateChats.rn,
    })
    .from(aggregateChats)
    .where(lte(aggregateChats.rn, 100));
  const overflowRows = db
    .select({
      threadId: sql`NULL::uuid`
        .mapWith(nullableDriverValueDecoder(chatThreads.id))
        .as("thread_id"),
      threadTitle: sql`'others'::text`
        .mapWith(nullableDriverValueDecoder(pgTextDecoder))
        .as("thread_title"),
      credits: safeIntegerSum(aggregateChats.credits).as("credits"),
      tokens: safeIntegerSum(aggregateChats.tokens).as("tokens"),
      rn: sql`101::bigint`.mapWith(pgInt8ToSafeIntegerDecoder).as("rn"),
    })
    .from(aggregateChats)
    .where(gt(aggregateChats.rn, 100));
  const chatRows = unionAll(topChatRows, overflowRows).as("chat_rows");
  const rows = await db
    .with(usageRows, aggregateChats)
    .select({
      threadId: chatRows.threadId,
      threadTitle: chatRows.threadTitle,
      credits: chatRows.credits,
      tokens: chatRows.tokens,
      rn: chatRows.rn,
    })
    .from(chatRows)
    .orderBy(chatRows.rn);

  const chats: UsageInsightChatRow[] = [];
  let chatOtherCredits = 0;
  let hasChatOverflow = false;
  for (const row of rows) {
    if (row.rn > 100) {
      chatOtherCredits = row.credits;
      hasChatOverflow = true;
    } else if (row.threadId) {
      chats.push({
        threadId: row.threadId,
        threadTitle: row.threadTitle ?? null,
        credits: row.credits,
        tokens: row.tokens,
      });
    }
  }

  let chatOtherCount = 0;
  if (hasChatOverflow) {
    const countUsageRows = usageRowsCte(db, p);
    const rankedChats = db.$with("agg").as(
      db
        .select({
          threadId: zeroRuns.chatThreadId,
          rn: chatRankExpr(
            countUsageRows.creditsCharged,
            zeroRuns.chatThreadId,
          ).as("rn"),
        })
        .from(countUsageRows)
        .innerJoin(zeroRuns, eq(zeroRuns.id, countUsageRows.runId))
        .where(isNotNull(zeroRuns.chatThreadId))
        .groupBy(zeroRuns.chatThreadId),
    );
    const countRows = await db
      .with(countUsageRows, rankedChats)
      .select({
        count: sql`${count()}::bigint`
          .mapWith(pgInt8ToSafeIntegerDecoder)
          .as("cnt"),
      })
      .from(rankedChats)
      .where(gt(rankedChats.rn, 100));
    chatOtherCount = countRows[0]?.count ?? 0;
  }

  return { chats, chatOtherCount, chatOtherCredits };
}

export const zeroUsageInsight$ = command(
  async (
    { set },
    args: UsageInsightArgs,
    signal: AbortSignal,
  ): Promise<UsageInsightResponse> => {
    const db = set(writeDb$);
    const { trunc, startTs, endTs } = rangeToWindow(
      args.options.range,
      args.options.tz,
      args.options.date,
    );
    const normalizedWindow = normalizeFinalizedUsagePeriod({
      start: startTs,
      end: endTs,
    });
    const params: UsageInsightSqlParams = {
      userId: args.userId,
      orgId: args.orgId,
      startTs: normalizedWindow.start,
      endTs: normalizedWindow.end,
      trunc,
      tz: args.options.tz,
    };

    signal.throwIfAborted();
    const bucketsResult =
      args.options.groupBy === "source"
        ? await queryUsageInsightSourceBuckets(db, params)
        : await queryUsageInsightAgentBuckets(db, params);

    signal.throwIfAborted();
    const buckets = pivotBucketRows(bucketsResult);
    const { grandTotalCredits, grandTotalTokens } =
      await queryUsageInsightGrandTotal(db, params);
    signal.throwIfAborted();
    const { emailCredits, emailTokens, slackCredits, slackTokens } =
      await queryUsageInsightChannelTotals(db, params);
    signal.throwIfAborted();
    const { chats, chatOtherCount, chatOtherCredits } =
      await queryUsageInsightTopChats(db, params);
    signal.throwIfAborted();

    return {
      buckets,
      automations: [],
      automationOtherCount: 0,
      automationOtherCredits: 0,
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
  },
);
