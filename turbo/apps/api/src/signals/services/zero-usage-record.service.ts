import { command } from "ccstate";
import { sql } from "drizzle-orm";
import type {
  UsageRecordRow,
  UsageRecordResponse,
  UsageRecordSource,
} from "@vm0/api-contracts/contracts/zero-usage-record";

import { writeDb$, type Db } from "../external/db";

const MODEL_USAGE_KIND = "model";
const MODEL_TOKEN_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;
const THREADED_SOURCES = ["chat", "schedule"] as const;
const PASSTHROUGH_TRIGGER_SOURCES = [
  "schedule",
  "slack",
  "telegram",
  "email",
  "agentphone",
  "github",
  "cli",
  "agent",
] as const;

interface UsageRecordArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly page: number;
  readonly pageSize: number;
  readonly source?: UsageRecordSource;
}

interface UsageRecordSqlRow extends Record<string, unknown> {
  source: string;
  thread_id: string | null;
  run_id: string | null;
  title: string | null;
  credits: string;
  tokens: string;
  last_activity: Date | string;
}

function pgLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function tokenExpr(): string {
  const list = MODEL_TOKEN_CATEGORIES.map(pgLit).join(", ");
  return `CASE WHEN ue.kind = ${pgLit(MODEL_USAGE_KIND)} AND ue.category IN (${list}) THEN ue.quantity ELSE 0 END`;
}

function sourceExpr(triggerSource: string): string {
  const passthroughList = PASSTHROUGH_TRIGGER_SOURCES.map(pgLit).join(", ");
  return `
    CASE
      WHEN ${triggerSource} = 'web' THEN 'chat'
      WHEN ${triggerSource} IN (${passthroughList}) THEN ${triggerSource}
      ELSE 'other'
    END`;
}

// Per-source usage for one user in one org. `record` is the shared CTE so the
// row query and the count query stay in sync. Threaded sources collapse to one
// row per source/thread; everything else is one row per run.
function recordWith(userIdLit: string, orgIdLit: string): string {
  const threadedSourceList = THREADED_SOURCES.map(pgLit).join(", ");
  return `
    WITH usage_rows AS (
      SELECT
        ue.run_id,
        COALESCE(ue.credits_charged, 0)::bigint AS credits,
        ${tokenExpr()}::bigint AS tokens
      FROM usage_event ue
      WHERE ue.user_id = ${userIdLit}
        AND ue.org_id = ${orgIdLit}
        AND ue.status = 'processed'
    ),
    runs AS (
      SELECT
        ur.run_id,
        ur.credits,
        ur.tokens,
        ${sourceExpr("zr.trigger_source")} AS source,
        zr.chat_thread_id,
        zr.summary,
        ar.prompt,
        ar.created_at
      FROM usage_rows ur
      INNER JOIN zero_runs zr ON zr.id = ur.run_id
      INNER JOIN agent_runs ar ON ar.id = ur.run_id
    ),
    threaded AS (
      SELECT
        r.source,
        r.chat_thread_id::text AS thread_id,
        NULL::text AS run_id,
        ct.title AS title,
        COALESCE(SUM(r.credits), 0)::bigint AS credits,
        COALESCE(SUM(r.tokens), 0)::bigint AS tokens,
        MAX(r.created_at) AS last_activity
      FROM runs r
      LEFT JOIN chat_threads ct ON ct.id = r.chat_thread_id
      WHERE r.chat_thread_id IS NOT NULL
        AND r.source IN (${threadedSourceList})
      GROUP BY r.source, r.chat_thread_id, ct.title
    ),
    unthreaded AS (
      SELECT
        r.source,
        NULL::text AS thread_id,
        r.run_id::text AS run_id,
        LEFT(COALESCE(NULLIF(MAX(r.summary), ''), MAX(r.prompt)), 120) AS title,
        COALESCE(SUM(r.credits), 0)::bigint AS credits,
        COALESCE(SUM(r.tokens), 0)::bigint AS tokens,
        MAX(r.created_at) AS last_activity
      FROM runs r
      WHERE r.chat_thread_id IS NULL
        OR r.source NOT IN (${threadedSourceList})
      GROUP BY r.run_id, r.source
    ),
    record AS (
      SELECT * FROM threaded
      UNION ALL
      SELECT * FROM unthreaded
    )`;
}

async function queryUsageRecordRows(
  db: Db,
  recordCte: string,
  sourceFilterLit: string | null,
  pageSize: number,
  offset: number,
): Promise<UsageRecordRow[]> {
  const where = sourceFilterLit ? `WHERE source = ${sourceFilterLit}` : "";
  const result = await db.execute<UsageRecordSqlRow>(
    sql.raw(`
      ${recordCte}
      SELECT source, thread_id, run_id, title, credits, tokens, last_activity
      FROM record
      ${where}
      ORDER BY last_activity DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `),
  );
  return result.rows.map((row) => {
    const lastActivity =
      row.last_activity instanceof Date
        ? row.last_activity.toISOString()
        : new Date(row.last_activity).toISOString();
    return {
      source: row.source as UsageRecordSource,
      threadId: row.thread_id,
      runId: row.run_id,
      title: row.title,
      credits: Number(row.credits),
      tokens: Number(row.tokens),
      lastActivityAt: lastActivity,
    };
  });
}

async function queryUsageRecordTotal(
  db: Db,
  recordCte: string,
  sourceFilterLit: string | null,
): Promise<number> {
  const where = sourceFilterLit ? `WHERE source = ${sourceFilterLit}` : "";
  const result = await db.execute<{ total: string }>(
    sql.raw(`
      ${recordCte}
      SELECT COUNT(*)::bigint AS total FROM record ${where}
    `),
  );
  return Number(result.rows[0]?.total ?? 0);
}

export const zeroUsageRecord$ = command(
  async (
    { set },
    args: UsageRecordArgs,
    signal: AbortSignal,
  ): Promise<UsageRecordResponse> => {
    const db = set(writeDb$);
    const userIdLit = pgLit(args.userId);
    const orgIdLit = pgLit(args.orgId);
    const sourceFilterLit = args.source ? pgLit(args.source) : null;
    const offset = (args.page - 1) * args.pageSize;
    const recordCte = recordWith(userIdLit, orgIdLit);

    signal.throwIfAborted();
    const rows = await queryUsageRecordRows(
      db,
      recordCte,
      sourceFilterLit,
      args.pageSize,
      offset,
    );
    signal.throwIfAborted();
    const total = await queryUsageRecordTotal(db, recordCte, sourceFilterLit);
    signal.throwIfAborted();

    return {
      rows,
      pagination: {
        page: args.page,
        pageSize: args.pageSize,
        total,
      },
    };
  },
);
