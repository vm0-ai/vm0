import { command } from "ccstate";
import { sql } from "drizzle-orm";
import type {
  UsageRecordChatRow,
  UsageRecordResponse,
} from "@vm0/api-contracts/contracts/zero-usage-record";

import { writeDb$, type Db } from "../external/db";

const MODEL_USAGE_KIND = "model";
const MODEL_TOKEN_CATEGORIES = [
  "tokens.input",
  "tokens.output",
  "tokens.cache_read",
  "tokens.cache_creation",
] as const;

interface UsageRecordArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly page: number;
  readonly pageSize: number;
}

interface UsageRecordRow extends Record<string, unknown> {
  thread_id: string;
  thread_title: string | null;
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

// Per-chat usage for one user in one org, aggregated across every run in the
// chat. `per_chat` is the shared CTE so the row query and the count query stay
// in sync.
function perChatWith(userIdLit: string, orgIdLit: string): string {
  return `
    WITH usage_rows AS (
      SELECT
        ue.run_id,
        COALESCE(ue.credits_charged, 0)::bigint AS credits_charged,
        ${tokenExpr()}::bigint AS tokens
      FROM usage_event ue
      WHERE ue.user_id = ${userIdLit}
        AND ue.org_id = ${orgIdLit}
        AND ue.status = 'processed'
    ),
    per_chat AS (
      SELECT
        zr.chat_thread_id AS thread_id,
        ct.title AS thread_title,
        COALESCE(SUM(ur.credits_charged), 0)::bigint AS credits,
        COALESCE(SUM(ur.tokens), 0)::bigint AS tokens,
        MAX(ar.created_at) AS last_activity
      FROM usage_rows ur
      INNER JOIN zero_runs zr ON zr.id = ur.run_id
      INNER JOIN agent_runs ar ON ar.id = ur.run_id
      LEFT JOIN chat_threads ct ON ct.id = zr.chat_thread_id
      WHERE zr.chat_thread_id IS NOT NULL
      GROUP BY zr.chat_thread_id, ct.title
    )`;
}

async function queryUsageRecordRows(
  db: Db,
  userIdLit: string,
  orgIdLit: string,
  pageSize: number,
  offset: number,
): Promise<UsageRecordChatRow[]> {
  const result = await db.execute<UsageRecordRow>(
    sql.raw(`
      ${perChatWith(userIdLit, orgIdLit)}
      SELECT thread_id, thread_title, credits, tokens, last_activity
      FROM per_chat
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
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      credits: Number(row.credits),
      tokens: Number(row.tokens),
      lastActivityAt: lastActivity,
    };
  });
}

async function queryUsageRecordTotal(
  db: Db,
  userIdLit: string,
  orgIdLit: string,
): Promise<number> {
  const result = await db.execute<{ total: string }>(
    sql.raw(`
      ${perChatWith(userIdLit, orgIdLit)}
      SELECT COUNT(*)::bigint AS total FROM per_chat
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
    const offset = (args.page - 1) * args.pageSize;

    signal.throwIfAborted();
    const chats = await queryUsageRecordRows(
      db,
      userIdLit,
      orgIdLit,
      args.pageSize,
      offset,
    );
    signal.throwIfAborted();
    const total = await queryUsageRecordTotal(db, userIdLit, orgIdLit);
    signal.throwIfAborted();

    return {
      chats,
      pagination: {
        page: args.page,
        pageSize: args.pageSize,
        total,
      },
    };
  },
);
