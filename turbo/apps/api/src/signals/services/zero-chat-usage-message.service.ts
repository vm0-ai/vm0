import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatMessages,
  type ChatMessageUsageKindBreakdown,
  type ChatMessageUsagePayload,
  type ChatMessageUsageProviderBreakdown,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { nowDate } from "../external/time";

const L = logger("ChatUsageMessage");

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    return Number(value);
  }
  return 0;
}

function buildUsageBreakdown(
  rows: readonly {
    readonly kind: string;
    readonly provider: string;
    readonly credits: unknown;
  }[],
): readonly ChatMessageUsageKindBreakdown[] {
  const byKind = new Map<string, ChatMessageUsageProviderBreakdown[]>();
  for (const row of rows) {
    const providers = byKind.get(row.kind) ?? [];
    providers.push({
      provider: row.provider,
      credits: Math.max(0, toNumber(row.credits)),
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

export const maybeEmitRunUsageMessage$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<boolean> => {
    const db = set(writeDb$);
    const [context] = await db
      .select({
        status: agentRuns.status,
        chatThreadId: zeroRuns.chatThreadId,
        userId: chatThreads.userId,
        pendingCount: sql<number>`COUNT(${usageEvent.id}) FILTER (WHERE ${usageEvent.status} = 'pending')::int`,
        processedCount: sql<number>`COUNT(${usageEvent.id}) FILTER (WHERE ${usageEvent.status} = 'processed')::int`,
        totalCredits: sql<number>`COALESCE(SUM(COALESCE(${usageEvent.creditsCharged}, 0)) FILTER (WHERE ${usageEvent.status} = 'processed'), 0)::bigint`,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .leftJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
      .leftJoin(usageEvent, eq(usageEvent.runId, agentRuns.id))
      .where(eq(agentRuns.id, runId))
      .groupBy(agentRuns.status, zeroRuns.chatThreadId, chatThreads.userId)
      .limit(1);
    signal.throwIfAborted();

    if (!context) {
      return false;
    }
    if (
      !TERMINAL_RUN_STATUSES.includes(
        context.status as (typeof TERMINAL_RUN_STATUSES)[number],
      )
    ) {
      return false;
    }
    if (!context.chatThreadId || !context.userId) {
      return false;
    }
    if (
      toNumber(context.pendingCount) > 0 ||
      toNumber(context.processedCount) === 0
    ) {
      return false;
    }

    const breakdownRows = await db
      .select({
        kind: usageEvent.kind,
        provider: sql<string>`COALESCE(NULLIF(${usageEvent.provider}, ''), 'unknown')`,
        credits: sql<number>`COALESCE(SUM(COALESCE(${usageEvent.creditsCharged}, 0)), 0)::bigint`,
      })
      .from(usageEvent)
      .where(
        and(eq(usageEvent.runId, runId), eq(usageEvent.status, "processed")),
      )
      .groupBy(usageEvent.kind, usageEvent.provider)
      .orderBy(usageEvent.kind, usageEvent.provider);
    signal.throwIfAborted();

    const payload: ChatMessageUsagePayload = {
      version: 1,
      totalCredits: Math.max(0, toNumber(context.totalCredits)),
      settledAt: nowDate().toISOString(),
      breakdown: buildUsageBreakdown(breakdownRows),
    };

    const [inserted] = await db
      .insert(chatMessages)
      .values({
        chatThreadId: context.chatThreadId,
        role: "assistant",
        content: null,
        runId,
        usagePayload: payload,
      })
      .onConflictDoNothing({
        target: chatMessages.runId,
        where: sql`${chatMessages.usagePayload} IS NOT NULL`,
      })
      .returning({ id: chatMessages.id });
    signal.throwIfAborted();

    if (!inserted) {
      return false;
    }

    await publishUserSignal(
      [context.userId],
      `chatThreadMessageCreated:${context.chatThreadId}`,
    );
    signal.throwIfAborted();

    L.debug("Emitted chat usage message", {
      runId,
      chatThreadId: context.chatThreadId,
      totalCredits: payload.totalCredits,
    });

    return true;
  },
);
