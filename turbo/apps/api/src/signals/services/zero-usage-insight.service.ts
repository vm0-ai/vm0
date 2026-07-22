import { command } from "ccstate";
import { count, sql } from "drizzle-orm";
import type {
  UsageInsightBucket,
  UsageInsightChatRow,
  UsageInsightResponse,
} from "@vm0/api-contracts/contracts/zero-usage-insight";
import { z } from "zod";

import {
  executeRawRows,
  pgInt8ToSafeIntegerSchema,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";

const MODEL_USAGE_KIND = "model";
const MODEL_TOKEN_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;

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
  readonly startTs: string;
  readonly endTs: string;
  readonly trunc: "hour" | "day";
  readonly tz: string;
}

const usageInsightBucketRowSchema = z.object({
  ts: pgTimestampWithoutTimezoneToDateSchema,
  bucket: z.string(),
  credits: pgInt8ToSafeIntegerSchema,
  tokens: pgInt8ToSafeIntegerSchema,
});
type UsageInsightBucketRow = z.output<typeof usageInsightBucketRowSchema>;

const usageInsightGrandTotalRowSchema = z.object({
  grand_credits: pgInt8ToSafeIntegerSchema,
  grand_tokens: pgInt8ToSafeIntegerSchema,
});

const usageInsightChannelTotalRowSchema = z.object({
  source: z.enum(["email", "slack"]),
  credits: pgInt8ToSafeIntegerSchema,
  tokens: pgInt8ToSafeIntegerSchema,
});

const usageInsightTopChatRowSchema = z.object({
  thread_id: z.string().nullable(),
  thread_title: z.string().nullable(),
  credits: pgInt8ToSafeIntegerSchema,
  tokens: pgInt8ToSafeIntegerSchema,
  rn: pgInt8ToSafeIntegerSchema,
});

const usageInsightCountRowSchema = z.object({
  cnt: pgInt8ToSafeIntegerSchema,
});

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

function usageBucketExpr(p: UsageInsightSqlParams) {
  return sql`date_trunc(${p.trunc}, ur.activity_time AT TIME ZONE 'UTC' AT TIME ZONE ${p.tz})`;
}

function activityTimeWindowPredicate(p: UsageInsightSqlParams) {
  return sql`ue.created_at AT TIME ZONE 'UTC' >= ${p.startTs}::timestamptz
        AND ue.created_at AT TIME ZONE 'UTC' < ${p.endTs}::timestamptz`;
}

function usageRowTokenExpr() {
  const tokenCategoryList = sql.join(
    MODEL_TOKEN_CATEGORIES.map((category) => {
      return sql`${category}`;
    }),
    sql`, `,
  );
  return sql`CASE WHEN ue.kind = ${MODEL_USAGE_KIND} AND ue.category IN (${tokenCategoryList}) THEN ue.quantity ELSE 0 END`;
}

function usageCreditsExpr() {
  return sql`COALESCE(ue.credits_charged, 0) + COALESCE(uaa.units_applied, 0)`;
}

function usageRowsCte(p: UsageInsightSqlParams) {
  return sql`
    usage_rows AS (
      SELECT
        ue.created_at AS activity_time,
        ue.run_id,
        ue.user_id,
        ue.org_id,
        ${usageCreditsExpr()}::bigint AS credits_charged,
        ${usageRowTokenExpr()}::bigint AS tokens
      FROM usage_event ue
      LEFT JOIN usage_allowance_allocations uaa ON uaa.usage_event_id = ue.id
      WHERE ue.user_id = ${p.userId}
        AND ue.org_id = ${p.orgId}
        AND ue.status = 'processed'
        AND ${activityTimeWindowPredicate(p)}
    )`;
}

function usageRowsWith(p: UsageInsightSqlParams) {
  return sql`WITH ${usageRowsCte(p)}`;
}

function agentNameExpr() {
  return sql`CASE
    WHEN ar.id IS NULL THEN 'others'
    ELSE COALESCE(za.display_name, za.name, acv_compose.name, 'unknown')
  END`;
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

function queryUsageInsightSourceBuckets(db: Db, p: UsageInsightSqlParams) {
  return executeRawRows(
    db,
    sql`
      ${usageRowsWith(p)}
      SELECT
        ${usageBucketExpr(p)} AS ts,
        CASE
          WHEN zr.trigger_source = 'web' THEN 'chat'
          WHEN zr.trigger_source = 'slack' THEN 'slack'
          WHEN zr.trigger_source = 'email' THEN 'email'
          WHEN zr.trigger_source IN ('workflow-schedule', 'workflow-event') THEN 'automation'
          ELSE 'others'
        END AS bucket,
        COALESCE(SUM(ur.credits_charged), 0)::bigint AS credits,
        COALESCE(SUM(ur.tokens), 0)::bigint AS tokens
      FROM usage_rows ur
      LEFT JOIN zero_runs zr ON zr.id = ur.run_id
      GROUP BY 1, 2
      ORDER BY 1
    `,
    usageInsightBucketRowSchema,
  );
}

function queryUsageInsightAgentBuckets(db: Db, p: UsageInsightSqlParams) {
  const agentName = agentNameExpr();

  return executeRawRows(
    db,
    sql`
      ${usageRowsWith(p)},
      agent_totals AS (
        SELECT
          ${agentName} AS agent_name,
          COALESCE(SUM(ur.credits_charged), 0)::bigint AS total_credits
        FROM usage_rows ur
        LEFT JOIN agent_runs ar ON ar.id = ur.run_id
        LEFT JOIN agent_compose_versions acv ON acv.id = ar.agent_compose_version_id
        LEFT JOIN agent_composes acv_compose ON acv_compose.id = acv.compose_id
        LEFT JOIN zero_agents za ON za.id = acv_compose.id
        GROUP BY 1
        ORDER BY 2 DESC
      ),
      top7 AS (SELECT agent_name FROM agent_totals LIMIT 7)
      SELECT
        ${usageBucketExpr(p)} AS ts,
        CASE
          WHEN ${agentName} IN (SELECT agent_name FROM top7)
          THEN ${agentName}
          ELSE 'others'
        END AS bucket,
        COALESCE(SUM(ur.credits_charged), 0)::bigint AS credits,
        COALESCE(SUM(ur.tokens), 0)::bigint AS tokens
      FROM usage_rows ur
      LEFT JOIN agent_runs ar ON ar.id = ur.run_id
      LEFT JOIN agent_compose_versions acv ON acv.id = ar.agent_compose_version_id
      LEFT JOIN agent_composes acv_compose ON acv_compose.id = acv.compose_id
      LEFT JOIN zero_agents za ON za.id = acv_compose.id
      GROUP BY 1, 2
      ORDER BY 1
    `,
    usageInsightBucketRowSchema,
  );
}

async function queryUsageInsightGrandTotal(
  db: Db,
  p: UsageInsightSqlParams,
): Promise<{ grandTotalCredits: number; grandTotalTokens: number }> {
  const rows = await executeRawRows(
    db,
    sql`
      ${usageRowsWith(p)}
      SELECT
        COALESCE(SUM(ur.credits_charged), 0)::bigint AS grand_credits,
        COALESCE(SUM(ur.tokens), 0)::bigint AS grand_tokens
      FROM usage_rows ur
    `,
    usageInsightGrandTotalRowSchema,
  );
  return {
    grandTotalCredits: rows[0]?.grand_credits ?? 0,
    grandTotalTokens: rows[0]?.grand_tokens ?? 0,
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
  const rows = await executeRawRows(
    db,
    sql`
      ${usageRowsWith(p)}
      SELECT
        zr.trigger_source AS source,
        COALESCE(SUM(ur.credits_charged), 0)::bigint AS credits,
        COALESCE(SUM(ur.tokens), 0)::bigint AS tokens
      FROM usage_rows ur
      LEFT JOIN zero_runs zr ON zr.id = ur.run_id
      WHERE zr.trigger_source IN ('email', 'slack')
      GROUP BY 1
    `,
    usageInsightChannelTotalRowSchema,
  );
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
  const rows = await executeRawRows(
    db,
    sql`
      ${usageRowsWith(p)},
      agg AS (
        SELECT
          zr.chat_thread_id,
          ct.title AS thread_title,
          COALESCE(SUM(ur.credits_charged), 0)::bigint AS credits,
          COALESCE(SUM(ur.tokens), 0)::bigint AS tokens,
          ROW_NUMBER() OVER (ORDER BY SUM(ur.credits_charged) DESC NULLS LAST) AS rn
        FROM usage_rows ur
        INNER JOIN zero_runs zr ON zr.id = ur.run_id
        LEFT JOIN chat_threads ct ON ct.id = zr.chat_thread_id
        WHERE zr.chat_thread_id IS NOT NULL
        GROUP BY zr.chat_thread_id, ct.title
      )
      SELECT chat_thread_id AS thread_id, thread_title, credits, tokens, rn
      FROM agg WHERE rn <= 100
      UNION ALL
      SELECT
        NULL AS thread_id,
        'others' AS thread_title,
        COALESCE(SUM(credits), 0)::bigint AS credits,
        COALESCE(SUM(tokens), 0)::bigint AS tokens,
        101 AS rn
      FROM agg WHERE rn > 100
      ORDER BY rn
    `,
    usageInsightTopChatRowSchema,
  );

  const chats: UsageInsightChatRow[] = [];
  let chatOtherCredits = 0;
  let hasChatOverflow = false;
  for (const row of rows) {
    if (row.rn > 100) {
      chatOtherCredits = row.credits;
      hasChatOverflow = true;
    } else if (row.thread_id) {
      chats.push({
        threadId: row.thread_id,
        threadTitle: row.thread_title ?? null,
        credits: row.credits,
        tokens: row.tokens,
      });
    }
  }

  let chatOtherCount = 0;
  if (hasChatOverflow) {
    const countRows = await executeRawRows(
      db,
      sql`
        ${usageRowsWith(p)},
        agg AS (
          SELECT zr.chat_thread_id,
            ROW_NUMBER() OVER (ORDER BY SUM(ur.credits_charged) DESC NULLS LAST) AS rn
          FROM usage_rows ur
          INNER JOIN zero_runs zr ON zr.id = ur.run_id
          WHERE zr.chat_thread_id IS NOT NULL
          GROUP BY zr.chat_thread_id
        )
        SELECT ${count()}::bigint AS cnt FROM agg WHERE rn > 100
      `,
      usageInsightCountRowSchema,
    );
    chatOtherCount = countRows[0]?.cnt ?? 0;
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
    const params: UsageInsightSqlParams = {
      userId: args.userId,
      orgId: args.orgId,
      startTs: startTs.toISOString(),
      endTs: endTs.toISOString(),
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
