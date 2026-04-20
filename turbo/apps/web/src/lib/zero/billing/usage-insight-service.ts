import { sql } from "drizzle-orm";
import type { UsageInsightResponse } from "@vm0/core";

interface UsageInsightOptions {
  range: "24h" | "7d" | "28d";
  groupBy: "source" | "agent";
  tz: string;
}

function rangeToTruncAndMs(range: "24h" | "7d" | "28d"): {
  trunc: string;
  ms: number;
} {
  switch (range) {
    case "24h":
      return { trunc: "hour", ms: 24 * 60 * 60 * 1000 };
    case "7d":
      return { trunc: "day", ms: 7 * 24 * 60 * 60 * 1000 };
    case "28d":
      return { trunc: "day", ms: 28 * 24 * 60 * 60 * 1000 };
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
  const { trunc, ms } = rangeToTruncAndMs(options.range);

  const endTs = new Date();
  const startTs = new Date(endTs.getTime() - ms);

  const startTsLit = pgLit(startTs.toISOString());
  const endTsLit = pgLit(endTs.toISOString());
  const userIdLit = pgLit(userId);
  const orgIdLit = pgLit(orgId);
  const truncLit = pgLit(trunc);
  const tzLit = pgLit(options.tz);

  // ----- 1. Buckets query -----
  const bucketsRows = await (async () => {
    if (options.groupBy === "source") {
      return db.execute<{
        ts: Date | string;
        bucket: string;
        credits: string;
        tokens: string;
      }>(
        sql.raw(`
          SELECT
            date_trunc(${truncLit}, cu.created_at::timestamptz AT TIME ZONE ${tzLit}) AS ts,
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
          WHERE cu.user_id = ${userIdLit}
            AND cu.org_id = ${orgIdLit}
            AND cu.status = 'processed'
            AND cu.created_at >= ${startTsLit}::timestamptz
            AND cu.created_at < ${endTsLit}::timestamptz
          GROUP BY 1, 2
          ORDER BY 1
        `),
      );
    }

    // groupBy === "agent"
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
          WHERE cu.user_id = ${userIdLit}
            AND cu.org_id = ${orgIdLit}
            AND cu.status = 'processed'
            AND cu.created_at >= ${startTsLit}::timestamptz
            AND cu.created_at < ${endTsLit}::timestamptz
          GROUP BY 1
          ORDER BY 2 DESC
        ),
        top7 AS (SELECT agent_name FROM agent_totals LIMIT 7)
        SELECT
          date_trunc(${truncLit}, cu.created_at::timestamptz AT TIME ZONE ${tzLit}) AS ts,
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
        WHERE cu.user_id = ${userIdLit}
          AND cu.org_id = ${orgIdLit}
          AND cu.status = 'processed'
          AND cu.created_at >= ${startTsLit}::timestamptz
          AND cu.created_at < ${endTsLit}::timestamptz
        GROUP BY 1, 2
        ORDER BY 1
      `),
    );
  })();

  // Pivot rows into bucket objects: ts -> { seriesKey -> credits }
  const bucketMap = new Map<
    string,
    { series: Record<string, number>; tokens: Record<string, number> }
  >();
  for (const row of bucketsRows.rows) {
    const tsStr =
      row.ts instanceof Date ? row.ts.toISOString() : String(row.ts);
    if (!bucketMap.has(tsStr)) {
      bucketMap.set(tsStr, { series: {}, tokens: {} });
    }
    const entry = bucketMap.get(tsStr)!;
    entry.series[row.bucket] = Number(row.credits);
    entry.tokens[row.bucket] = Number(row.tokens);
  }
  const buckets = [...bucketMap.entries()]
    .sort(([a], [b]) => {
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map(([ts, { series, tokens }]) => {
      return { ts, series, tokens };
    });

  // ----- 2. Grand total + channel totals (no join to zero_runs — handles NULL run_id) -----
  const grandRows = await db.execute<{
    grand_credits: string;
    grand_tokens: string;
  }>(
    sql.raw(`
      SELECT
        COALESCE(SUM(credits_charged), 0)::bigint AS grand_credits,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens), 0)::bigint AS grand_tokens
      FROM credit_usage
      WHERE user_id = ${userIdLit}
        AND org_id = ${orgIdLit}
        AND status = 'processed'
        AND created_at >= ${startTsLit}::timestamptz
        AND created_at < ${endTsLit}::timestamptz
    `),
  );
  const grandTotalCredits = Number(grandRows.rows[0]?.grand_credits ?? 0);
  const grandTotalTokens = Number(grandRows.rows[0]?.grand_tokens ?? 0);

  // Email and Slack channel totals — LEFT JOIN zero_runs for trigger_source filter
  const channelRows = await db.execute<{
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
      WHERE cu.user_id = ${userIdLit}
        AND cu.org_id = ${orgIdLit}
        AND cu.status = 'processed'
        AND cu.created_at >= ${startTsLit}::timestamptz
        AND cu.created_at < ${endTsLit}::timestamptz
        AND zr.trigger_source IN ('email', 'slack')
      GROUP BY 1
    `),
  );

  let emailCredits = 0;
  let emailTokens = 0;
  let slackCredits = 0;
  let slackTokens = 0;
  for (const row of channelRows.rows) {
    if (row.source === "email") {
      emailCredits = Number(row.credits);
      emailTokens = Number(row.tokens);
    } else if (row.source === "slack") {
      slackCredits = Number(row.credits);
      slackTokens = Number(row.tokens);
    }
  }

  // ----- 3. Top-100 schedules -----
  const scheduleRows = await db.execute<{
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
        WHERE cu.user_id = ${userIdLit}
          AND cu.org_id = ${orgIdLit}
          AND cu.status = 'processed'
          AND cu.created_at >= ${startTsLit}::timestamptz
          AND cu.created_at < ${endTsLit}::timestamptz
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
  let scheduleOtherCount = 0;
  let scheduleOtherCredits = 0;

  for (const row of scheduleRows.rows) {
    if (Number(row.rn) > 100) {
      scheduleOtherCredits = Number(row.credits);
    } else if (row.schedule_id) {
      schedules.push({
        scheduleId: row.schedule_id,
        scheduleName: row.schedule_name ?? "Unnamed schedule",
        credits: Number(row.credits),
        tokens: Number(row.tokens),
      });
    }
  }

  // Count other schedules directly
  if (scheduleOtherCredits > 0) {
    const otherCountRows = await db.execute<{ cnt: string }>(
      sql.raw(`
        WITH agg AS (
          SELECT
            zr.schedule_id,
            ROW_NUMBER() OVER (ORDER BY SUM(cu.credits_charged) DESC NULLS LAST) AS rn
          FROM credit_usage cu
          INNER JOIN zero_runs zr ON zr.id = cu.run_id
          WHERE cu.user_id = ${userIdLit}
            AND cu.org_id = ${orgIdLit}
            AND cu.status = 'processed'
            AND cu.created_at >= ${startTsLit}::timestamptz
            AND cu.created_at < ${endTsLit}::timestamptz
            AND zr.schedule_id IS NOT NULL
          GROUP BY zr.schedule_id
        )
        SELECT COUNT(*)::bigint AS cnt FROM agg WHERE rn > 100
      `),
    );
    scheduleOtherCount = Number(otherCountRows.rows[0]?.cnt ?? 0);
  }

  // ----- 4. Top-100 chats -----
  const chatRows = await db.execute<{
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
        WHERE cu.user_id = ${userIdLit}
          AND cu.org_id = ${orgIdLit}
          AND cu.status = 'processed'
          AND cu.created_at >= ${startTsLit}::timestamptz
          AND cu.created_at < ${endTsLit}::timestamptz
          AND zr.chat_thread_id IS NOT NULL
        GROUP BY zr.chat_thread_id, ct.title
      )
      SELECT
        chat_thread_id AS thread_id,
        thread_title,
        credits,
        tokens,
        rn
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
  let chatOtherCount = 0;
  let chatOtherCredits = 0;

  for (const row of chatRows.rows) {
    if (Number(row.rn) > 100) {
      chatOtherCredits = Number(row.credits);
    } else if (row.thread_id) {
      chats.push({
        threadId: row.thread_id,
        threadTitle: row.thread_title ?? null,
        credits: Number(row.credits),
        tokens: Number(row.tokens),
      });
    }
  }

  if (chatOtherCredits > 0) {
    const otherCountRows = await db.execute<{ cnt: string }>(
      sql.raw(`
        WITH agg AS (
          SELECT
            zr.chat_thread_id,
            ROW_NUMBER() OVER (ORDER BY SUM(cu.credits_charged) DESC NULLS LAST) AS rn
          FROM credit_usage cu
          INNER JOIN zero_runs zr ON zr.id = cu.run_id
          WHERE cu.user_id = ${userIdLit}
            AND cu.org_id = ${orgIdLit}
            AND cu.status = 'processed'
            AND cu.created_at >= ${startTsLit}::timestamptz
            AND cu.created_at < ${endTsLit}::timestamptz
            AND zr.chat_thread_id IS NOT NULL
          GROUP BY zr.chat_thread_id
        )
        SELECT COUNT(*)::bigint AS cnt FROM agg WHERE rn > 100
      `),
    );
    chatOtherCount = Number(otherCountRows.rows[0]?.cnt ?? 0);
  }

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
