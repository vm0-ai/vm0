import { command } from "ccstate";
import { and, count, eq, exists, max, sql, sum } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatEvents,
  type ChatEventUsageKindBreakdown,
  type ChatEventUsagePayload,
  type ChatEventUsageProviderBreakdown,
} from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import {
  pgBooleanDecoder,
  pgIntegerDecoder,
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { insertChatEvent } from "./zero-chat-event.service";
import {
  buildFinalizedUsageRelation,
  type FinalizedUsageRelation,
} from "./finalized-usage-relation";

const L = logger("ChatUsageMessage");
type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;
const USAGE_CONTEXT_GROUP_BY_COLUMNS = [
  agentRuns.status,
  zeroRuns.chatThreadId,
  zeroRuns.runGroupId,
  chatThreads.userId,
] as const;

function buildUsageBreakdown(
  rows: readonly {
    readonly kind: string;
    readonly provider: string;
    readonly credits: number;
  }[],
): readonly ChatEventUsageKindBreakdown[] {
  const byKind = new Map<string, ChatEventUsageProviderBreakdown[]>();
  for (const row of rows) {
    const providers = byKind.get(row.kind) ?? [];
    providers.push({
      provider: row.provider,
      credits: Math.max(0, row.credits),
    });
    byKind.set(row.kind, providers);
  }

  return Array.from(byKind.entries()).map(([kind, providers]) => {
    const credits = providers.reduce((sum, provider) => {
      return sum + provider.credits;
    }, 0);
    return { kind, credits, providers };
  });
}

function usageCreditsExpression(usage: FinalizedUsageRelation) {
  return sql`${usage.creditsCharged} + ${usage.allowanceUnits}`;
}

async function loadUsageEventContext(tx: WriteTx, runId: string) {
  const usage = buildFinalizedUsageRelation();
  return await tx
    .select({
      status: agentRuns.status,
      chatThreadId: zeroRuns.chatThreadId,
      runGroupId: zeroRuns.runGroupId,
      userId: chatThreads.userId,
      hasPending: exists(
        tx
          .select({ id: usageEvent.id })
          .from(usageEvent)
          .where(
            and(eq(usageEvent.runId, runId), eq(usageEvent.status, "pending")),
          ),
      )
        .mapWith(pgBooleanDecoder)
        .as("has_pending"),
      finalizedCount: sql`${count(usage.orgId)}::int`
        .mapWith(pgIntegerDecoder)
        .as("finalized_count"),
      totalCredits:
        sql`COALESCE(${sum(usageCreditsExpression(usage))}, 0)::bigint`.mapWith(
          pgInt8ToSafeIntegerDecoder,
        ),
      settledAt: sql`COALESCE(
        ${max(agentRuns.completedAt)},
        ${max(agentRuns.createdAt)}
      )`.mapWith(agentRuns.createdAt),
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .leftJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
    .leftJoin(usage, eq(usage.runId, agentRuns.id))
    .where(eq(agentRuns.id, runId))
    .groupBy(...USAGE_CONTEXT_GROUP_BY_COLUMNS)
    .limit(1);
}

async function loadUsageBreakdownRows(tx: WriteTx, runId: string) {
  const usage = buildFinalizedUsageRelation();
  return await tx
    .select({
      kind: usage.kind,
      provider: sql`COALESCE(NULLIF(${usage.provider}, ''), 'unknown')`.mapWith(
        pgTextDecoder,
      ),
      credits:
        sql`COALESCE(${sum(usageCreditsExpression(usage))}, 0)::bigint`.mapWith(
          pgInt8ToSafeIntegerDecoder,
        ),
    })
    .from(usage)
    .where(eq(usage.runId, runId))
    .groupBy(usage.kind, usage.provider)
    .orderBy(usage.kind, usage.provider);
}

export const maybeEmitRunUsageEvent$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<boolean> => {
    const db = set(writeDb$);
    const emitted = await db.transaction(async (tx) => {
      // Multiple terminal side effects can attempt emission for the same run.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('chat_usage_message:' || ${runId}))`,
      );
      signal.throwIfAborted();

      const [context] = await loadUsageEventContext(tx, runId);
      signal.throwIfAborted();

      if (!context) {
        return null;
      }
      if (
        !TERMINAL_RUN_STATUSES.includes(
          context.status as (typeof TERMINAL_RUN_STATUSES)[number],
        )
      ) {
        return null;
      }
      if (!context.chatThreadId || !context.userId) {
        return null;
      }
      if (context.hasPending || context.finalizedCount === 0) {
        return null;
      }

      const [existingUsageEvent] = await tx
        .select({ id: chatEvents.id })
        .from(chatEvents)
        .where(
          and(eq(chatEvents.runId, runId), chatEventTypeIn(["usage.recorded"])),
        )
        .limit(1);
      signal.throwIfAborted();

      if (existingUsageEvent) {
        return null;
      }

      const breakdownRows = await loadUsageBreakdownRows(tx, runId);
      signal.throwIfAborted();

      const payload: ChatEventUsagePayload = {
        version: 1,
        totalCredits: Math.max(0, context.totalCredits),
        settledAt: context.settledAt.toISOString(),
        breakdown: buildUsageBreakdown(breakdownRows),
      };

      const inserted = await insertChatEvent(tx, {
        chatThreadId: context.chatThreadId,
        eventType: "usage.recorded",
        content: null,
        runId,
        runGroupId: context.runGroupId,
        usagePayload: payload,
        createdAt: new Date(payload.settledAt),
      });
      signal.throwIfAborted();

      if (!inserted) {
        return null;
      }

      return {
        chatThreadId: context.chatThreadId,
        userId: context.userId,
        totalCredits: payload.totalCredits,
      };
    });
    signal.throwIfAborted();

    if (!emitted) {
      return false;
    }

    await publishUserSignal(
      [emitted.userId],
      `chatThreadMessageCreated:${emitted.chatThreadId}`,
    );
    signal.throwIfAborted();

    L.debug("Emitted chat usage message", {
      runId,
      chatThreadId: emitted.chatThreadId,
      totalCredits: emitted.totalCredits,
    });

    return true;
  },
);
