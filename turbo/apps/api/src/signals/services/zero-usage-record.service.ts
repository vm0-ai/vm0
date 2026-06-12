import { command } from "ccstate";
import { sql } from "drizzle-orm";
import type {
  UsageRecordKind,
  UsageRecordRow,
  UsageRecordResponse,
  UsageRecordScope,
  UsageRecordSource,
} from "@vm0/api-contracts/contracts/zero-usage-record";

import { clerk$ } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import { getOrgBillingPeriod$ } from "./zero-org-billing-period.service";
import { resolveEmails } from "./zero-usage.service";
import {
  fixedRangeToPeriod,
  type UsagePeriod,
  type UsageRangeArg,
} from "./usage-period";

const MODEL_USAGE_KIND = "model";
const MODEL_TOKEN_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;
const THREADED_SOURCES = ["chat", "automation"] as const;
const USAGE_RECORD_KINDS = ["model", "image", "video", "connector"] as const;
const PASSTHROUGH_TRIGGER_SOURCES = [
  "automation",
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
  readonly scope: UsageRecordScope;
  readonly range: UsageRangeArg;
  readonly tz: string;
  readonly page: number;
  readonly pageSize: number;
  readonly source?: UsageRecordSource;
}

interface UsageRecordSqlRow extends Record<string, unknown> {
  row_key: string;
  source: string;
  user_id: string;
  thread_id: string | null;
  run_id: string | null;
  title: string | null;
  credits: string;
  tokens: string;
  last_activity: Date | string;
}

interface UsageRecordIntermediateRow extends UsageRecordRow {
  readonly rowKey: string;
  readonly userId: string;
}

interface UsageRecordBreakdownSqlRow extends Record<string, unknown> {
  row_key: string;
  kind: string;
  provider: string;
  credits: string;
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

function usageKindExpr(kind: string): string {
  const usageKindList = USAGE_RECORD_KINDS.map(pgLit).join(", ");
  return `
    CASE
      WHEN ${kind} IN (${usageKindList}) THEN ${kind}
      ELSE 'other'
    END`;
}

// Per-source usage for one user in one org. `record` is the shared CTE so the
// row query and the count query stay in sync. Threaded sources collapse to one
// row per source/thread; everything else is one row per run.
function recordWith(
  userIdLit: string,
  orgIdLit: string,
  period: UsagePeriod | null,
): string {
  const threadedSourceList = THREADED_SOURCES.map(pgLit).join(", ");
  const userPredicate = userIdLit ? `AND ue.user_id = ${userIdLit}` : "";
  const periodPredicate = period
    ? `
        AND ue.created_at >= ${pgLit(period.start.toISOString())}::timestamptz
        AND ue.created_at < ${pgLit(period.end.toISOString())}::timestamptz`
    : "";
  return `
    WITH usage_rows AS (
      SELECT
        ue.run_id,
        ue.user_id,
        COALESCE(ue.credits_charged, 0)::bigint AS credits,
        ${tokenExpr()}::bigint AS tokens
      FROM usage_event ue
      WHERE ue.org_id = ${orgIdLit}
        ${userPredicate}
        AND ue.status = 'processed'
        ${periodPredicate}
    ),
    runs AS (
      SELECT
        ur.run_id,
        ur.user_id,
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
        CONCAT(r.source, ':thread:', r.chat_thread_id::text, ':user:', r.user_id) AS row_key,
        r.source,
        r.user_id,
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
      GROUP BY r.source, r.user_id, r.chat_thread_id, ct.title
    ),
    unthreaded AS (
      SELECT
        CONCAT(r.source, ':run:', r.run_id::text, ':user:', r.user_id) AS row_key,
        r.source,
        r.user_id,
        NULL::text AS thread_id,
        r.run_id::text AS run_id,
        LEFT(COALESCE(NULLIF(MAX(r.summary), ''), MAX(r.prompt)), 120) AS title,
        COALESCE(SUM(r.credits), 0)::bigint AS credits,
        COALESCE(SUM(r.tokens), 0)::bigint AS tokens,
        MAX(r.created_at) AS last_activity
      FROM runs r
      WHERE r.chat_thread_id IS NULL
        OR r.source NOT IN (${threadedSourceList})
      GROUP BY r.run_id, r.source, r.user_id
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
): Promise<UsageRecordIntermediateRow[]> {
  const where = sourceFilterLit ? `WHERE source = ${sourceFilterLit}` : "";
  const result = await db.execute<UsageRecordSqlRow>(
    sql.raw(`
      ${recordCte}
      SELECT row_key, source, user_id, thread_id, run_id, title, credits, tokens, last_activity
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
      rowKey: row.row_key,
      source: row.source as UsageRecordSource,
      userId: row.user_id,
      threadId: row.thread_id,
      runId: row.run_id,
      title: row.title,
      credits: Number(row.credits),
      tokens: Number(row.tokens),
      breakdown: [],
      member: null,
      lastActivityAt: lastActivity,
    };
  });
}

async function queryUsageRecordTotals(
  db: Db,
  recordCte: string,
  sourceFilterLit: string | null,
): Promise<{ total: number; totalCredits: number }> {
  const where = sourceFilterLit ? `WHERE source = ${sourceFilterLit}` : "";
  const result = await db.execute<{ total: string; total_credits: string }>(
    sql.raw(`
      ${recordCte}
      SELECT COUNT(*)::bigint AS total, COALESCE(SUM(credits), 0)::bigint AS total_credits
      FROM record ${where}
    `),
  );
  return {
    total: Number(result.rows[0]?.total ?? 0),
    totalCredits: Number(result.rows[0]?.total_credits ?? 0),
  };
}

function rowKeyExpr(
  source: string,
  chatThreadId: string,
  runId: string,
  userId: string,
): string {
  const threadedSourceList = THREADED_SOURCES.map(pgLit).join(", ");
  return `
    CASE
      WHEN ${chatThreadId} IS NOT NULL AND ${source} IN (${threadedSourceList})
        THEN CONCAT(${source}, ':thread:', ${chatThreadId}::text, ':user:', ${userId})
      ELSE CONCAT(${source}, ':run:', ${runId}::text, ':user:', ${userId})
    END`;
}

async function queryUsageRecordBreakdown(
  db: Db,
  userIdLit: string,
  orgIdLit: string,
  period: UsagePeriod | null,
  rowKeys: readonly string[],
): Promise<Map<string, UsageRecordRow["breakdown"]>> {
  if (rowKeys.length === 0) {
    return new Map();
  }

  const userPredicate = userIdLit ? `AND ue.user_id = ${userIdLit}` : "";
  const periodPredicate = period
    ? `
          AND ue.created_at >= ${pgLit(period.start.toISOString())}::timestamptz
          AND ue.created_at < ${pgLit(period.end.toISOString())}::timestamptz`
    : "";
  const rowKeyList = rowKeys.map(pgLit).join(", ");
  const sourceSql = sourceExpr("zr.trigger_source");
  const kindSql = usageKindExpr("ue.kind");

  const result = await db.execute<UsageRecordBreakdownSqlRow>(
    sql.raw(`
      WITH usage_rows AS (
        SELECT
          ${sourceSql} AS source,
          zr.chat_thread_id,
          ue.run_id,
          ue.user_id,
          ${kindSql} AS kind,
          COALESCE(NULLIF(ue.provider, ''), 'unknown') AS provider,
          COALESCE(ue.credits_charged, 0)::bigint AS credits
        FROM usage_event ue
        INNER JOIN zero_runs zr ON zr.id = ue.run_id
        WHERE ue.org_id = ${orgIdLit}
          ${userPredicate}
          AND ue.status = 'processed'
          ${periodPredicate}
      ),
      keyed AS (
        SELECT
          ${rowKeyExpr("source", "chat_thread_id", "run_id", "user_id")} AS row_key,
          kind,
          provider,
          credits
        FROM usage_rows
      )
      SELECT row_key, kind, provider, SUM(credits)::bigint AS credits
      FROM keyed
      WHERE row_key IN (${rowKeyList})
      GROUP BY row_key, kind, provider
      HAVING SUM(credits) > 0
      ORDER BY row_key, kind, provider
    `),
  );

  const byRow = new Map<
    string,
    Map<UsageRecordKind, UsageRecordBreakdownSqlRow[]>
  >();
  for (const row of result.rows) {
    const kind = row.kind as UsageRecordKind;
    const kinds = byRow.get(row.row_key) ?? new Map();
    const providers = kinds.get(kind) ?? [];
    providers.push(row);
    kinds.set(kind, providers);
    byRow.set(row.row_key, kinds);
  }

  const breakdownByRow = new Map<string, UsageRecordRow["breakdown"]>();
  for (const [rowKey, kindMap] of byRow) {
    const breakdown: UsageRecordRow["breakdown"] = [];
    for (const kind of [
      "model",
      "image",
      "video",
      "connector",
      "other",
    ] as const) {
      const providerRows = kindMap.get(kind) ?? [];
      if (providerRows.length === 0) {
        continue;
      }
      const providers = providerRows.map((row) => {
        return {
          provider: row.provider,
          credits: Number(row.credits),
        };
      });
      breakdown.push({
        kind,
        credits: providers.reduce((sum, provider) => {
          return sum + provider.credits;
        }, 0),
        providers,
      });
    }
    breakdownByRow.set(rowKey, breakdown);
  }

  return breakdownByRow;
}

export const zeroUsageRecord$ = command(
  async (
    { get, set },
    args: UsageRecordArgs,
    signal: AbortSignal,
  ): Promise<UsageRecordResponse> => {
    const billingPeriod =
      args.range === "billingPeriod"
        ? await set(getOrgBillingPeriod$, args.orgId, signal)
        : null;
    signal.throwIfAborted();

    if (args.range === "billingPeriod" && !billingPeriod) {
      return {
        period: null,
        rows: [],
        totalCredits: 0,
        pagination: {
          page: args.page,
          pageSize: args.pageSize,
          total: 0,
        },
      };
    }

    const period =
      args.range === "all"
        ? null
        : args.range === "billingPeriod"
          ? billingPeriod
          : fixedRangeToPeriod(args.range, args.tz);
    if (args.range !== "all" && !period) {
      throw new Error("usage record period was not resolved");
    }

    const db = set(writeDb$);
    const userIdLit = args.scope === "mine" ? pgLit(args.userId) : "";
    const orgIdLit = pgLit(args.orgId);
    const sourceFilterLit = args.source ? pgLit(args.source) : null;
    const offset = (args.page - 1) * args.pageSize;
    const recordCte = recordWith(userIdLit, orgIdLit, period);

    signal.throwIfAborted();
    const rows = await queryUsageRecordRows(
      db,
      recordCte,
      sourceFilterLit,
      args.pageSize,
      offset,
    );
    signal.throwIfAborted();
    const breakdownByRow = await queryUsageRecordBreakdown(
      db,
      userIdLit,
      orgIdLit,
      period,
      rows.map((row) => {
        return row.rowKey;
      }),
    );
    signal.throwIfAborted();
    const { total, totalCredits } = await queryUsageRecordTotals(
      db,
      recordCte,
      sourceFilterLit,
    );
    signal.throwIfAborted();

    const emailMap =
      args.scope === "team"
        ? await resolveEmails(
            get(clerk$),
            db,
            [
              ...new Set(
                rows.map((row) => {
                  return row.userId;
                }),
              ),
            ],
            signal,
          )
        : new Map<string, string>();
    signal.throwIfAborted();

    return {
      period: period
        ? {
            start: period.start.toISOString(),
            end: period.end.toISOString(),
          }
        : null,
      rows: rows.map((row) => {
        return {
          source: row.source,
          threadId: row.threadId,
          runId: row.runId,
          title: row.title,
          credits: row.credits,
          tokens: row.tokens,
          breakdown: breakdownByRow.get(row.rowKey) ?? [],
          member:
            args.scope === "team"
              ? {
                  userId: row.userId,
                  email: emailMap.get(row.userId) ?? "unknown",
                }
              : null,
          lastActivityAt: row.lastActivityAt,
        };
      }),
      totalCredits,
      pagination: {
        page: args.page,
        pageSize: args.pageSize,
        total,
      },
    };
  },
);
