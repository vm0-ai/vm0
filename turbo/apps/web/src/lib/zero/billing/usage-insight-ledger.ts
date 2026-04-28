import { sql } from "drizzle-orm";
import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";
import type { Database } from "../../../types/global";
import {
  MODEL_TOKEN_CATEGORIES,
  MODEL_USAGE_KIND,
} from "./model-usage-categories";

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

const USAGE_ROW_ALIAS = "ur";

function pgLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function usageBucketExpr(p: UsageInsightSqlParams): string {
  return `date_trunc(${p.truncLit}, ${USAGE_ROW_ALIAS}.activity_time::timestamptz AT TIME ZONE ${p.tzLit})`;
}

function activityTimeWindowPredicate(
  alias: string,
  p: UsageInsightSqlParams,
): string {
  return `${alias}.created_at >= ${p.startTsLit}::timestamptz
        AND ${alias}.created_at < ${p.endTsLit}::timestamptz`;
}

function usageRowTokenExpr(): string {
  const tokenCategoryList = MODEL_TOKEN_CATEGORIES.map(pgLit).join(", ");
  return `CASE WHEN ue.kind = ${pgLit(MODEL_USAGE_KIND)} AND ue.category IN (${tokenCategoryList}) THEN ue.quantity ELSE 0 END`;
}

/**
 * Reporting time terms:
 * - activityTime maps to ledger created_at, when usage activity was recorded.
 * - billingTime maps to ledger processed_at, when credits were settled.
 *
 * Usage insight is an activity chart, so it filters and buckets by
 * activityTime while still requiring processed rows. Delayed billing must not
 * move usage into a later activity bucket.
 */
function usageRowsCte(p: UsageInsightSqlParams): string {
  return `
    usage_rows AS (
      SELECT
        'legacy' AS ledger,
        cu.created_at AS activity_time,
        cu.run_id,
        cu.user_id,
        cu.org_id,
        COALESCE(cu.credits_charged, 0)::bigint AS credits_charged,
        (cu.input_tokens + cu.output_tokens + cu.cache_read_input_tokens + cu.cache_creation_input_tokens)::bigint AS tokens
      FROM credit_usage cu
      WHERE cu.user_id = ${p.userIdLit}
        AND cu.org_id = ${p.orgIdLit}
        AND cu.status = 'processed'
        AND ${activityTimeWindowPredicate("cu", p)}

      UNION ALL

      SELECT
        'event' AS ledger,
        ue.created_at AS activity_time,
        ue.run_id,
        ue.user_id,
        ue.org_id,
        COALESCE(ue.credits_charged, 0)::bigint AS credits_charged,
        ${usageRowTokenExpr()}::bigint AS tokens
      FROM usage_event ue
      WHERE ue.user_id = ${p.userIdLit}
        AND ue.org_id = ${p.orgIdLit}
        AND ue.status = 'processed'
        AND ${activityTimeWindowPredicate("ue", p)}
    )`;
}

function usageRowsWith(p: UsageInsightSqlParams): string {
  return `WITH ${usageRowsCte(p)}`;
}

function agentNameExpr(): string {
  return `CASE
    WHEN ${USAGE_ROW_ALIAS}.ledger = 'event' AND ar.id IS NULL THEN 'others'
    ELSE COALESCE(za.display_name, za.name, acv_compose.name, 'unknown')
  END`;
}

export async function queryUsageInsightSourceBuckets(
  db: Database,
  p: UsageInsightSqlParams,
) {
  return db.execute<UsageInsightBucketRow>(
    sql.raw(`
      ${usageRowsWith(p)}
      SELECT
        ${usageBucketExpr(p)} AS ts,
        CASE
          WHEN zr.trigger_source = 'web' THEN 'chat'
          WHEN zr.trigger_source = 'slack' THEN 'slack'
          WHEN zr.trigger_source = 'email' THEN 'email'
          WHEN zr.trigger_source = 'schedule' THEN 'schedule'
          ELSE 'others'
        END AS bucket,
        COALESCE(SUM(${USAGE_ROW_ALIAS}.credits_charged), 0)::bigint AS credits,
        COALESCE(SUM(${USAGE_ROW_ALIAS}.tokens), 0)::bigint AS tokens
      FROM usage_rows ${USAGE_ROW_ALIAS}
      LEFT JOIN zero_runs zr ON zr.id = ${USAGE_ROW_ALIAS}.run_id
      GROUP BY 1, 2
      ORDER BY 1
    `),
  );
}

export async function queryUsageInsightAgentBuckets(
  db: Database,
  p: UsageInsightSqlParams,
) {
  const agentName = agentNameExpr();

  return db.execute<UsageInsightBucketRow>(
    sql.raw(`
      ${usageRowsWith(p)},
      agent_totals AS (
        SELECT
          ${agentName} AS agent_name,
          COALESCE(SUM(${USAGE_ROW_ALIAS}.credits_charged), 0)::bigint AS total_credits
        FROM usage_rows ${USAGE_ROW_ALIAS}
        LEFT JOIN agent_runs ar ON ar.id = ${USAGE_ROW_ALIAS}.run_id
        LEFT JOIN agent_compose_versions acv ON acv.id = ar.agent_compose_version_id
        LEFT JOIN agent_composes acv_compose ON acv_compose.id = acv.compose_id
        LEFT JOIN zero_agents za ON za.id = acv_compose.id
        WHERE ${USAGE_ROW_ALIAS}.ledger = 'event' OR ar.id IS NOT NULL
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
        COALESCE(SUM(${USAGE_ROW_ALIAS}.credits_charged), 0)::bigint AS credits,
        COALESCE(SUM(${USAGE_ROW_ALIAS}.tokens), 0)::bigint AS tokens
      FROM usage_rows ${USAGE_ROW_ALIAS}
      LEFT JOIN agent_runs ar ON ar.id = ${USAGE_ROW_ALIAS}.run_id
      LEFT JOIN agent_compose_versions acv ON acv.id = ar.agent_compose_version_id
      LEFT JOIN agent_composes acv_compose ON acv_compose.id = acv.compose_id
      LEFT JOIN zero_agents za ON za.id = acv_compose.id
      WHERE ${USAGE_ROW_ALIAS}.ledger = 'event' OR ar.id IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 1
    `),
  );
}

export async function queryUsageInsightGrandTotal(
  db: Database,
  p: UsageInsightSqlParams,
): Promise<{ grandTotalCredits: number; grandTotalTokens: number }> {
  const rows = await db.execute<{
    grand_credits: string;
    grand_tokens: string;
  }>(
    sql.raw(`
      ${usageRowsWith(p)}
      SELECT
        COALESCE(SUM(${USAGE_ROW_ALIAS}.credits_charged), 0)::bigint AS grand_credits,
        COALESCE(SUM(${USAGE_ROW_ALIAS}.tokens), 0)::bigint AS grand_tokens
      FROM usage_rows ${USAGE_ROW_ALIAS}
    `),
  );
  return {
    grandTotalCredits: Number(rows.rows[0]?.grand_credits ?? 0),
    grandTotalTokens: Number(rows.rows[0]?.grand_tokens ?? 0),
  };
}

export async function queryUsageInsightChannelTotals(
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
      ${usageRowsWith(p)}
      SELECT
        zr.trigger_source AS source,
        COALESCE(SUM(${USAGE_ROW_ALIAS}.credits_charged), 0)::bigint AS credits,
        COALESCE(SUM(${USAGE_ROW_ALIAS}.tokens), 0)::bigint AS tokens
      FROM usage_rows ${USAGE_ROW_ALIAS}
      LEFT JOIN zero_runs zr ON zr.id = ${USAGE_ROW_ALIAS}.run_id
      WHERE zr.trigger_source IN ('email', 'slack')
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

export async function queryUsageInsightTopSchedules(
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
      ${usageRowsWith(p)},
      agg AS (
        SELECT
          zr.schedule_id,
          COALESCE(zas.name, 'Unnamed schedule') AS schedule_name,
          COALESCE(SUM(${USAGE_ROW_ALIAS}.credits_charged), 0)::bigint AS credits,
          COALESCE(SUM(${USAGE_ROW_ALIAS}.tokens), 0)::bigint AS tokens,
          ROW_NUMBER() OVER (ORDER BY SUM(${USAGE_ROW_ALIAS}.credits_charged) DESC NULLS LAST) AS rn
        FROM usage_rows ${USAGE_ROW_ALIAS}
        INNER JOIN zero_runs zr ON zr.id = ${USAGE_ROW_ALIAS}.run_id
        LEFT JOIN zero_agent_schedules zas ON zas.id = zr.schedule_id
        WHERE zr.schedule_id IS NOT NULL
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
        ${usageRowsWith(p)},
        agg AS (
          SELECT zr.schedule_id,
            ROW_NUMBER() OVER (ORDER BY SUM(${USAGE_ROW_ALIAS}.credits_charged) DESC NULLS LAST) AS rn
          FROM usage_rows ${USAGE_ROW_ALIAS}
          INNER JOIN zero_runs zr ON zr.id = ${USAGE_ROW_ALIAS}.run_id
          WHERE zr.schedule_id IS NOT NULL
          GROUP BY zr.schedule_id
        )
        SELECT COUNT(*)::bigint AS cnt FROM agg WHERE rn > 100
      `),
    );
    scheduleOtherCount = Number(countRows.rows[0]?.cnt ?? 0);
  }

  return { schedules, scheduleOtherCount, scheduleOtherCredits };
}

export async function queryUsageInsightTopChats(
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
      ${usageRowsWith(p)},
      agg AS (
        SELECT
          zr.chat_thread_id,
          ct.title AS thread_title,
          COALESCE(SUM(${USAGE_ROW_ALIAS}.credits_charged), 0)::bigint AS credits,
          COALESCE(SUM(${USAGE_ROW_ALIAS}.tokens), 0)::bigint AS tokens,
          ROW_NUMBER() OVER (ORDER BY SUM(${USAGE_ROW_ALIAS}.credits_charged) DESC NULLS LAST) AS rn
        FROM usage_rows ${USAGE_ROW_ALIAS}
        INNER JOIN zero_runs zr ON zr.id = ${USAGE_ROW_ALIAS}.run_id
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
        ${usageRowsWith(p)},
        agg AS (
          SELECT zr.chat_thread_id,
            ROW_NUMBER() OVER (ORDER BY SUM(${USAGE_ROW_ALIAS}.credits_charged) DESC NULLS LAST) AS rn
          FROM usage_rows ${USAGE_ROW_ALIAS}
          INNER JOIN zero_runs zr ON zr.id = ${USAGE_ROW_ALIAS}.run_id
          WHERE zr.chat_thread_id IS NOT NULL
          GROUP BY zr.chat_thread_id
        )
        SELECT COUNT(*)::bigint AS cnt FROM agg WHERE rn > 100
      `),
    );
    chatOtherCount = Number(countRows.rows[0]?.cnt ?? 0);
  }

  return { chats, chatOtherCount, chatOtherCredits };
}
