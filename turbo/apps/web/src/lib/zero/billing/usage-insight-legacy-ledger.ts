import { sql } from "drizzle-orm";
import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";
import type { Database } from "../../../types/global";

export interface UsageInsightSqlParams {
  userIdLit: string;
  orgIdLit: string;
  startTsLit: string;
  endTsLit: string;
  truncLit: string;
  tzLit: string;
}

export interface UsageInsightBucketRow extends Record<string, unknown> {
  ts: Date | string;
  bucket: string;
  credits: string;
  tokens: string;
}

const LEGACY_USAGE_TIME_COLUMN = "cu.created_at";

function usageBucketExpr(p: UsageInsightSqlParams): string {
  return `date_trunc(${p.truncLit}, ${LEGACY_USAGE_TIME_COLUMN}::timestamptz AT TIME ZONE ${p.tzLit})`;
}

function usageWindowPredicate(p: UsageInsightSqlParams): string {
  return `${LEGACY_USAGE_TIME_COLUMN} >= ${p.startTsLit}::timestamptz
        AND ${LEGACY_USAGE_TIME_COLUMN} < ${p.endTsLit}::timestamptz`;
}

function totalTokensExpr(alias: string): string {
  return `COALESCE(SUM(cu.input_tokens + cu.output_tokens + cu.cache_read_input_tokens + cu.cache_creation_input_tokens), 0)::bigint AS ${alias}`;
}

export async function queryLegacySourceBuckets(
  db: Database,
  p: UsageInsightSqlParams,
) {
  return db.execute<UsageInsightBucketRow>(
    sql.raw(`
      SELECT
        ${usageBucketExpr(p)} AS ts,
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
        AND ${usageWindowPredicate(p)}
      GROUP BY 1, 2
      ORDER BY 1
    `),
  );
}

export async function queryLegacyAgentBuckets(
  db: Database,
  p: UsageInsightSqlParams,
) {
  return db.execute<UsageInsightBucketRow>(
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
          AND ${usageWindowPredicate(p)}
        GROUP BY 1
        ORDER BY 2 DESC
      ),
      top7 AS (SELECT agent_name FROM agent_totals LIMIT 7)
      SELECT
        ${usageBucketExpr(p)} AS ts,
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
        AND ${usageWindowPredicate(p)}
      GROUP BY 1, 2
      ORDER BY 1
    `),
  );
}

export async function queryLegacyGrandTotal(
  db: Database,
  p: UsageInsightSqlParams,
): Promise<{ grandTotalCredits: number; grandTotalTokens: number }> {
  const rows = await db.execute<{
    grand_credits: string;
    grand_tokens: string;
  }>(
    sql.raw(`
      SELECT
        COALESCE(SUM(cu.credits_charged), 0)::bigint AS grand_credits,
        ${totalTokensExpr("grand_tokens")}
      FROM credit_usage cu
      WHERE cu.user_id = ${p.userIdLit}
        AND cu.org_id = ${p.orgIdLit}
        AND cu.status = 'processed'
        AND ${usageWindowPredicate(p)}
    `),
  );
  return {
    grandTotalCredits: Number(rows.rows[0]?.grand_credits ?? 0),
    grandTotalTokens: Number(rows.rows[0]?.grand_tokens ?? 0),
  };
}

export async function queryLegacyChannelTotals(
  db: Database,
  p: UsageInsightSqlParams,
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
        AND ${usageWindowPredicate(p)}
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

export async function queryLegacyTopSchedules(
  db: Database,
  p: UsageInsightSqlParams,
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
          AND ${usageWindowPredicate(p)}
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
            AND ${usageWindowPredicate(p)}
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

export async function queryLegacyTopChats(
  db: Database,
  p: UsageInsightSqlParams,
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
          AND ${usageWindowPredicate(p)}
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
            AND ${usageWindowPredicate(p)}
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
