import { command } from "ccstate";
import { count, sql, type SQL } from "drizzle-orm";
import {
  type UsageRecordKind,
  type UsageRecordRow,
  type UsageRecordResponse,
  type UsageRecordScope,
  type UsageRecordSource,
  usageRecordKindSchema,
  usageRecordSourceSchema,
} from "@vm0/api-contracts/contracts/zero-usage-record";
import { z } from "zod";

import {
  executeRawRows,
  pgInt8ToSafeIntegerSchema,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { timestampWithoutTimeZone } from "../../lib/time";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
import { getOrgBillingPeriod$ } from "./zero-org-billing-period.service";
import { normalizeFinalizedUsagePeriod } from "./finalized-usage-time";
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
  "slack",
  "teams",
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

interface UsageRecordIntermediateRow extends UsageRecordRow {
  readonly rowKey: string;
  readonly userId: string;
}

const usageRecordSqlRowSchema = z
  .object({
    row_key: z.string(),
    source: usageRecordSourceSchema,
    user_id: z.string(),
    thread_id: z.string().nullable(),
    run_id: z.string().nullable(),
    title: z.string().nullable(),
    credits: pgInt8ToSafeIntegerSchema,
    tokens: pgInt8ToSafeIntegerSchema,
    last_activity: pgTimestampWithoutTimezoneToDateSchema,
  })
  .transform((row): UsageRecordIntermediateRow => {
    return {
      rowKey: row.row_key,
      source: row.source,
      userId: row.user_id,
      threadId: row.thread_id,
      runId: row.run_id,
      title: row.title,
      credits: row.credits,
      tokens: row.tokens,
      breakdown: [],
      member: null,
      lastActivityAt: row.last_activity.toISOString(),
    };
  });

const usageRecordTotalsSqlRowSchema = z.object({
  total: pgInt8ToSafeIntegerSchema,
  total_credits: pgInt8ToSafeIntegerSchema,
});

const usageRecordBreakdownSqlRowSchema = z.object({
  row_key: z.string(),
  kind: usageRecordKindSchema,
  provider: z.string(),
  credits: pgInt8ToSafeIntegerSchema,
});
type UsageRecordBreakdownSqlRow = z.output<
  typeof usageRecordBreakdownSqlRowSchema
>;

function tokenExpr() {
  const list = sql.join(
    MODEL_TOKEN_CATEGORIES.map((category) => {
      return sql`${category}`;
    }),
    sql`, `,
  );
  return sql`CASE WHEN uf.kind = ${MODEL_USAGE_KIND} AND uf.category IN (${list}) THEN uf.quantity ELSE 0 END`;
}

function sourceExpr() {
  const passthroughList = sql.join(
    PASSTHROUGH_TRIGGER_SOURCES.map((source) => {
      return sql`${source}`;
    }),
    sql`, `,
  );
  return sql`
    CASE
      WHEN zr.trigger_source = 'web' THEN 'chat'
      WHEN zr.trigger_source IN ('workflow-schedule', 'workflow-event') THEN 'automation'
      WHEN zr.trigger_source IN (${passthroughList}) THEN zr.trigger_source
      ELSE 'other'
    END`;
}

function usageKindExpr() {
  const usageKindList = sql.join(
    USAGE_RECORD_KINDS.map((kind) => {
      return sql`${kind}`;
    }),
    sql`, `,
  );
  return sql`
    CASE
      WHEN uf.kind IN (${usageKindList}) THEN uf.kind
      ELSE 'other'
    END`;
}

function usageCreditsExpr() {
  return sql`uf.credits_charged + uf.allowance_units`;
}

// Per-source usage for one user in one org. `record` is the shared CTE so the
// row query and the count query stay in sync. Threaded sources collapse to one
// row per source/thread. Deleted threaded rows, whose thread FK has been set to
// NULL, collapse to one synthetic row per source/user. Everything else is one
// row per run.
function recordWith(
  userId: string | null,
  orgId: string,
  period: UsagePeriod | null,
): SQL {
  const threadedSourceList = sql.join(
    THREADED_SOURCES.map((source) => {
      return sql`${source}`;
    }),
    sql`, `,
  );
  const userPredicate =
    userId === null ? sql.empty() : sql`AND uf.user_id = ${userId}`;
  const normalizedPeriod = period
    ? normalizeFinalizedUsagePeriod(period)
    : null;
  const periodPredicate = normalizedPeriod
    ? sql`
        AND uf.activity_at >= ${timestampWithoutTimeZone(normalizedPeriod.start)}::timestamp
        AND uf.activity_at < ${timestampWithoutTimeZone(normalizedPeriod.end)}::timestamp`
    : sql.empty();
  return sql`
    WITH usage_rows AS (
      SELECT
        uf.run_id,
        uf.user_id,
        ${usageCreditsExpr()}::bigint AS credits,
        ${tokenExpr()}::bigint AS tokens
      FROM usage_event_finalized uf
      WHERE uf.org_id = ${orgId}
        ${userPredicate}
        AND uf.activity_at IS NOT NULL
        ${periodPredicate}
    ),
    runs AS (
      SELECT
        ur.run_id,
        ur.user_id,
        ur.credits,
        ur.tokens,
        ${sourceExpr()} AS source,
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
    deleted_threaded AS (
      SELECT
        CONCAT(r.source, ':deleted-thread:user:', r.user_id) AS row_key,
        r.source,
        r.user_id,
        NULL::text AS thread_id,
        NULL::text AS run_id,
        'Deleted chats'::text AS title,
        COALESCE(SUM(r.credits), 0)::bigint AS credits,
        COALESCE(SUM(r.tokens), 0)::bigint AS tokens,
        MAX(r.created_at) AS last_activity
      FROM runs r
      WHERE r.chat_thread_id IS NULL
        AND r.source IN (${threadedSourceList})
      GROUP BY r.source, r.user_id
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
      WHERE r.source NOT IN (${threadedSourceList})
      GROUP BY r.run_id, r.source, r.user_id
    ),
    record AS (
      SELECT * FROM threaded
      UNION ALL
      SELECT * FROM deleted_threaded
      UNION ALL
      SELECT * FROM unthreaded
    )`;
}

async function queryUsageRecordRows(
  db: Db,
  recordCte: SQL,
  sourceFilter: UsageRecordSource | undefined,
  pageSize: number,
  offset: number,
): Promise<UsageRecordIntermediateRow[]> {
  const where =
    sourceFilter === undefined
      ? sql.empty()
      : sql`WHERE source = ${sourceFilter}`;
  return await executeRawRows(
    db,
    sql`
      ${recordCte}
      SELECT row_key, source, user_id, thread_id, run_id, title, credits, tokens, last_activity
      FROM record
      ${where}
      ORDER BY last_activity DESC, row_key
      LIMIT ${pageSize} OFFSET ${offset}
    `,
    usageRecordSqlRowSchema,
  );
}

async function queryUsageRecordTotals(
  db: Db,
  recordCte: SQL,
  sourceFilter: UsageRecordSource | undefined,
): Promise<{ total: number; totalCredits: number }> {
  const where =
    sourceFilter === undefined
      ? sql.empty()
      : sql`WHERE source = ${sourceFilter}`;
  const rows = await executeRawRows(
    db,
    sql`
      ${recordCte}
      SELECT ${count()}::bigint AS total, COALESCE(SUM(credits), 0)::bigint AS total_credits
      FROM record ${where}
    `,
    usageRecordTotalsSqlRowSchema,
  );
  return {
    total: rows[0]?.total ?? 0,
    totalCredits: rows[0]?.total_credits ?? 0,
  };
}

function rowKeyExpr() {
  const threadedSourceList = sql.join(
    THREADED_SOURCES.map((source) => {
      return sql`${source}`;
    }),
    sql`, `,
  );
  return sql`
    CASE
      WHEN chat_thread_id IS NOT NULL AND source IN (${threadedSourceList})
        THEN CONCAT(source, ':thread:', chat_thread_id::text, ':user:', user_id)
      WHEN chat_thread_id IS NULL AND source IN (${threadedSourceList})
        THEN CONCAT(source, ':deleted-thread:user:', user_id)
      ELSE CONCAT(source, ':run:', run_id::text, ':user:', user_id)
    END`;
}

async function queryUsageRecordBreakdown(
  db: Db,
  userId: string | null,
  orgId: string,
  period: UsagePeriod | null,
  rowKeys: readonly string[],
): Promise<Map<string, UsageRecordRow["breakdown"]>> {
  if (rowKeys.length === 0) {
    return new Map();
  }

  const userPredicate =
    userId === null ? sql.empty() : sql`AND uf.user_id = ${userId}`;
  const normalizedPeriod = period
    ? normalizeFinalizedUsagePeriod(period)
    : null;
  const periodPredicate = normalizedPeriod
    ? sql`
          AND uf.activity_at >= ${timestampWithoutTimeZone(normalizedPeriod.start)}::timestamp
          AND uf.activity_at < ${timestampWithoutTimeZone(normalizedPeriod.end)}::timestamp`
    : sql.empty();
  const rowKeyList = sql.join(
    rowKeys.map((rowKey) => {
      return sql`${rowKey}`;
    }),
    sql`, `,
  );
  const sourceSql = sourceExpr();
  const kindSql = usageKindExpr();

  const rows = await executeRawRows(
    db,
    sql`
      WITH usage_rows AS (
        SELECT
          ${sourceSql} AS source,
          zr.chat_thread_id,
          uf.run_id,
          uf.user_id,
          ${kindSql} AS kind,
          COALESCE(NULLIF(uf.provider, ''), 'unknown') AS provider,
          ${usageCreditsExpr()}::bigint AS credits
        FROM usage_event_finalized uf
        INNER JOIN zero_runs zr ON zr.id = uf.run_id
        WHERE uf.org_id = ${orgId}
          ${userPredicate}
          AND uf.activity_at IS NOT NULL
          ${periodPredicate}
      ),
      keyed AS (
        SELECT
          ${rowKeyExpr()} AS row_key,
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
    `,
    usageRecordBreakdownSqlRowSchema,
  );

  const byRow = new Map<
    string,
    Map<UsageRecordKind, UsageRecordBreakdownSqlRow[]>
  >();
  for (const row of rows) {
    const kind = row.kind;
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
          credits: row.credits,
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
    const userId = args.scope === "mine" ? args.userId : null;
    const offset = (args.page - 1) * args.pageSize;
    const recordCte = recordWith(userId, args.orgId, period);

    signal.throwIfAborted();
    const rows = await queryUsageRecordRows(
      db,
      recordCte,
      args.source,
      args.pageSize,
      offset,
    );
    signal.throwIfAborted();
    const breakdownByRow = await queryUsageRecordBreakdown(
      db,
      userId,
      args.orgId,
      period,
      rows.map((row) => {
        return row.rowKey;
      }),
    );
    signal.throwIfAborted();
    const { total, totalCredits } = await queryUsageRecordTotals(
      db,
      recordCte,
      args.source,
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
