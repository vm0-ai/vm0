import { sql } from "drizzle-orm";
import type { UsageInsightResponse } from "@vm0/core";

interface UsageInsightOptions {
  range: "today" | "yesterday" | "7d" | "28d";
  groupBy: "source" | "agent";
  tz: string;
}

interface SqlParams {
  userIdLit: string;
  orgIdLit: string;
  startTsLit: string;
  endTsLit: string;
  truncLit: string;
  tzLit: string;
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

function totalTokensExpr(alias: string): string {
  return `COALESCE(SUM(cu.input_tokens + cu.output_tokens + cu.cache_read_input_tokens + cu.cache_creation_input_tokens), 0)::bigint AS ${alias}`;
}

async function querySourceBuckets(
  db: typeof globalThis.services.db,
  p: SqlParams,
) {
  return db.execute<{
    ts: Date | string;
    bucket: string;
    credits: string;
    tokens: string;
  }>(
    sql.raw(`
      SELECT
        date_trunc(${p.truncLit}, cu.created_at::timestamptz AT TIME ZONE ${p.tzLit}) AS ts,
        CASE
          WHEN zr.trigger_source = 'web' THEN 'chat'
          WHEN zr.trigger_source = 'slack' THEN 'slack'
          WHEN zr.trigger_source = 'email' THEN 'email'
          WHEN zr.trigger_source = 'schedule' THEN 'schedule'
          ELSE 'others'
        END AS bucket,
        COALESCE(SUM(cu.credits_charged), 0)::bigint AS credits,
        ${totalTokensExpr("tokens")}
      FROM credit_usage cu
      LEFT JOIN zero_runs zr ON zr.id = cu.run_id
      WHERE cu.user_id = ${p.userIdLit}
        AND cu.org_id = ${p.orgIdLit}
        AND cu.status = 'processed'
        AND cu.created_at >= ${p.startTsLit}::timestamptz
        AND cu.created_at < ${p.endTsLit}::timestamptz
      GROUP BY 1, 2
      ORDER BY 1
    `),
  );
}

async function queryAgentBuckets(
  db: typeof globalThis.services.db,
  p: SqlParams,
) {
  return db.execute<{
    ts: Date | string;
    bucket: string;
    credits: string;
    tokens: string;
  }>(
    sql.raw(`
      WITH agent_totals AS (
        SELECT
          COALESCE(za.display_name, za.name, acv_compose.name, 'unknown') AS agent_name,
          COALESCE(SUM(cu.credits_charged), 0)::bigint AS total_credits
        FROM credit_usage cu
        INNER JOIN agent_runs ar ON ar.id = cu.run_id
        INNER JOIN agent_compose_versions acv ON acv.id = ar.agent_compose_version_id
        INNER JOIN agent_composes acv_compose ON acv_compose.id = acv.compose_id
        LEFT JOIN zero_agents za ON za.id = acv_compose.id
        WHERE cu.user_id = ${p.userIdLit}
          AND cu.org_id = ${p.orgIdLit}
          AND cu.status = 'processed'
          AND cu.created_at >= ${p.startTsLit}::timestamptz
          AND cu.created_at < ${p.endTsLit}::timestamptz
        GROUP BY 1
        ORDER BY 2 DESC
      ),
      top7 AS (SELECT agent_name FROM agent_totals LIMIT 7)
      SELECT
        date_trunc(${p.truncLit}, cu.created_at::timestamptz AT TIME ZONE ${p.tzLit}) AS ts,
        CASE
          WHEN COALESCE(za.display_name, za.name, acv_compose.name, 'unknown') IN (SELECT agent_name FROM top7)
          THEN COALESCE(za.display_name, za.name, acv_compose.name, 'unknown')
          ELSE 'others'
        END AS bucket,
        COALESCE(SUM(cu.credits_charged), 0)::bigint AS credits,
        ${totalTokensExpr("tokens")}
      FROM credit_usage cu
      INNER JOIN agent_runs ar ON ar.id = cu.run_id
      INNER JOIN agent_compose_versions acv ON acv.id = ar.agent_compose_version_id
      INNER JOIN agent_composes acv_compose ON acv_compose.id = acv.compose_id
      LEFT JOIN zero_agents za ON za.id = acv_compose.id
      WHERE cu.user_id = ${p.userIdLit}
        AND cu.org_id = ${p.orgIdLit}
        AND cu.status = 'processed'
        AND cu.created_at >= ${p.startTsLit}::timestamptz
        AND cu.created_at < ${p.endTsLit}::timestamptz
      GROUP BY 1, 2
      ORDER BY 1
    `),
  );
}

function pivotBucketRows(
  rows: {
    ts: Date | string;
    bucket: string;
    credits: string;
    tokens: string;
  }[],
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

async function queryGrandTotal(
  db: typeof globalThis.services.db,
  p: SqlParams,
): Promise<{ grandTotalCredits: number; grandTotalTokens: number }> {
  const rows = await db.execute<{
    grand_credits: string;
    grand_tokens: string;
  }>(
    sql.raw(`
      SELECT
        COALESCE(SUM(credits_charged), 0)::bigint AS grand_credits,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens), 0)::bigint AS grand_tokens
      FROM credit_usage
      WHERE user_id = ${p.userIdLit}
        AND org_id = ${p.orgIdLit}
        AND status = 'processed'
        AND created_at >= ${p.startTsLit}::timestamptz
        AND created_at < ${p.endTsLit}::timestamptz
    `),
  );
  return {
    grandTotalCredits: Number(rows.rows[0]?.grand_credits ?? 0),
    grandTotalTokens: Number(rows.rows[0]?.grand_tokens ?? 0),
  };
}

async function queryChannelTotals(
  db: typeof globalThis.services.db,
  p: SqlParams,
): Promise<{
  emailCredits: number;
  emailTokens: number;
  slackCredits: number;
  slackTokens: number;
}> {
  const rows = await db.execute<{
    source: string;
    credits: string;
    tokens: string;
  }>(
    sql.raw(`
      SELECT
        zr.trigger_source AS source,
        COALESCE(SUM(cu.credits_charged), 0)::bigint AS credits,
        COALESCE(SUM(cu.input_tokens + cu.output_tokens + cu.cache_read_input_tokens + cu.cache_creation_input_tokens), 0)::bigint AS tokens
      FROM credit_usage cu
      LEFT JOIN zero_runs zr ON zr.id = cu.run_id
      WHERE cu.user_id = ${p.userIdLit}
        AND cu.org_id = ${p.orgIdLit}
        AND cu.status = 'processed'
        AND cu.created_at >= ${p.startTsLit}::timestamptz
        AND cu.created_at < ${p.endTsLit}::timestamptz
        AND zr.trigger_source IN ('email', 'slack')
      GROUP BY 1
    `),
  );
  let emailCredits = 0;
  let emailTokens = 0;
  let slackCredits = 0;
  let slackTokens = 0;
  for (const row of rows.rows) {
    if (row.source === "email") {
      emailCredits = Number(row.credits);
      emailTokens = Number(row.tokens);
    } else if (row.source === "slack") {
      slackCredits = Number(row.credits);
      slackTokens = Number(row.tokens);
    }
  }
  return { emailCredits, emailTokens, slackCredits, slackTokens };
}

async function queryTopSchedules(
  db: typeof globalThis.services.db,
  p: SqlParams,
): Promise<{
  schedules: UsageInsightResponse["schedules"];
  scheduleOtherCount: number;
  scheduleOtherCredits: number;
}> {
  const rows = await db.execute<{
    schedule_id: string | null;
    schedule_name: string | null;
    credits: string;
    tokens: string;
    rn: string;
  }>(
    sql.raw(`
      WITH agg AS (
        SELECT
          zr.schedule_id,
          COALESCE(zas.name, 'Unnamed schedule') AS schedule_name,
          COALESCE(SUM(cu.credits_charged), 0)::bigint AS credits,
          COALESCE(SUM(cu.input_tokens + cu.output_tokens + cu.cache_read_input_tokens + cu.cache_creation_input_tokens), 0)::bigint AS tokens,
          ROW_NUMBER() OVER (ORDER BY SUM(cu.credits_charged) DESC NULLS LAST) AS rn
        FROM credit_usage cu
        INNER JOIN zero_runs zr ON zr.id = cu.run_id
        LEFT JOIN zero_agent_schedules zas ON zas.id = zr.schedule_id
        WHERE cu.user_id = ${p.userIdLit}
          AND cu.org_id = ${p.orgIdLit}
          AND cu.status = 'processed'
          AND cu.created_at >= ${p.startTsLit}::timestamptz
          AND cu.created_at < ${p.endTsLit}::timestamptz
          AND zr.schedule_id IS NOT NULL
        GROUP BY zr.schedule_id, zas.name
      )
      SELECT * FROM agg WHERE rn <= 100
      UNION ALL
      SELECT
        NULL AS schedule_id,
        'others' AS schedule_name,
        COALESCE(SUM(credits), 0)::bigint AS credits,
        COALESCE(SUM(tokens), 0)::bigint AS tokens,
        101 AS rn
      FROM agg WHERE rn > 100
      ORDER BY rn
    `),
  );

  const schedules: UsageInsightResponse["schedules"] = [];
  let scheduleOtherCredits = 0;
  let hasScheduleOverflow = false;
  for (const row of rows.rows) {
    if (Number(row.rn) > 100) {
      scheduleOtherCredits = Number(row.credits);
      hasScheduleOverflow = true;
    } else if (row.schedule_id) {
      schedules.push({
        scheduleId: row.schedule_id,
        scheduleName: row.schedule_name ?? "Unnamed schedule",
        credits: Number(row.credits),
        tokens: Number(row.tokens),
      });
    }
  }

  let scheduleOtherCount = 0;
  if (hasScheduleOverflow) {
    const countRows = await db.execute<{ cnt: string }>(
      sql.raw(`
        WITH agg AS (
          SELECT zr.schedule_id,
            ROW_NUMBER() OVER (ORDER BY SUM(cu.credits_charged) DESC NULLS LAST) AS rn
          FROM credit_usage cu
          INNER JOIN zero_runs zr ON zr.id = cu.run_id
          WHERE cu.user_id = ${p.userIdLit}
            AND cu.org_id = ${p.orgIdLit}
            AND cu.status = 'processed'
            AND cu.created_at >= ${p.startTsLit}::timestamptz
            AND cu.created_at < ${p.endTsLit}::timestamptz
            AND zr.schedule_id IS NOT NULL
          GROUP BY zr.schedule_id
        )
        SELECT COUNT(*)::bigint AS cnt FROM agg WHERE rn > 100
      `),
    );
    scheduleOtherCount = Number(countRows.rows[0]?.cnt ?? 0);
  }

  return { schedules, scheduleOtherCount, scheduleOtherCredits };
}

async function queryTopChats(
  db: typeof globalThis.services.db,
  p: SqlParams,
): Promise<{
  chats: UsageInsightResponse["chats"];
  chatOtherCount: number;
  chatOtherCredits: number;
}> {
  const rows = await db.execute<{
    thread_id: string | null;
    thread_title: string | null;
    credits: string;
    tokens: string;
    rn: string;
  }>(
    sql.raw(`
      WITH agg AS (
        SELECT
          zr.chat_thread_id,
          ct.title AS thread_title,
          COALESCE(SUM(cu.credits_charged), 0)::bigint AS credits,
          COALESCE(SUM(cu.input_tokens + cu.output_tokens + cu.cache_read_input_tokens + cu.cache_creation_input_tokens), 0)::bigint AS tokens,
          ROW_NUMBER() OVER (ORDER BY SUM(cu.credits_charged) DESC NULLS LAST) AS rn
        FROM credit_usage cu
        INNER JOIN zero_runs zr ON zr.id = cu.run_id
        LEFT JOIN chat_threads ct ON ct.id = zr.chat_thread_id
        WHERE cu.user_id = ${p.userIdLit}
          AND cu.org_id = ${p.orgIdLit}
          AND cu.status = 'processed'
          AND cu.created_at >= ${p.startTsLit}::timestamptz
          AND cu.created_at < ${p.endTsLit}::timestamptz
          AND zr.chat_thread_id IS NOT NULL
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
    `),
  );

  const chats: UsageInsightResponse["chats"] = [];
  let chatOtherCredits = 0;
  let hasChatOverflow = false;
  for (const row of rows.rows) {
    if (Number(row.rn) > 100) {
      chatOtherCredits = Number(row.credits);
      hasChatOverflow = true;
    } else if (row.thread_id) {
      chats.push({
        threadId: row.thread_id,
        threadTitle: row.thread_title ?? null,
        credits: Number(row.credits),
        tokens: Number(row.tokens),
      });
    }
  }

  let chatOtherCount = 0;
  if (hasChatOverflow) {
    const countRows = await db.execute<{ cnt: string }>(
      sql.raw(`
        WITH agg AS (
          SELECT zr.chat_thread_id,
            ROW_NUMBER() OVER (ORDER BY SUM(cu.credits_charged) DESC NULLS LAST) AS rn
          FROM credit_usage cu
          INNER JOIN zero_runs zr ON zr.id = cu.run_id
          WHERE cu.user_id = ${p.userIdLit}
            AND cu.org_id = ${p.orgIdLit}
            AND cu.status = 'processed'
            AND cu.created_at >= ${p.startTsLit}::timestamptz
            AND cu.created_at < ${p.endTsLit}::timestamptz
            AND zr.chat_thread_id IS NOT NULL
          GROUP BY zr.chat_thread_id
        )
        SELECT COUNT(*)::bigint AS cnt FROM agg WHERE rn > 100
      `),
    );
    chatOtherCount = Number(countRows.rows[0]?.cnt ?? 0);
  }

  return { chats, chatOtherCount, chatOtherCredits };
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

  const p: SqlParams = {
    userIdLit: pgLit(userId),
    orgIdLit: pgLit(orgId),
    startTsLit: pgLit(startTs.toISOString()),
    endTsLit: pgLit(endTs.toISOString()),
    truncLit: pgLit(trunc),
    tzLit: pgLit(options.tz),
  };

  const bucketsResult =
    options.groupBy === "source"
      ? await querySourceBuckets(db, p)
      : await queryAgentBuckets(db, p);

  const buckets = pivotBucketRows(bucketsResult.rows);
  const { grandTotalCredits, grandTotalTokens } = await queryGrandTotal(db, p);
  const { emailCredits, emailTokens, slackCredits, slackTokens } =
    await queryChannelTotals(db, p);
  const { schedules, scheduleOtherCount, scheduleOtherCredits } =
    await queryTopSchedules(db, p);
  const { chats, chatOtherCount, chatOtherCredits } = await queryTopChats(
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
