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

function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const normalized = value.replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  return new Date(hasTimezone ? normalized : `${normalized}Z`).toISOString();
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

function usagePayloadKey(payload: ChatMessageUsagePayload): string {
  return JSON.stringify({
    version: payload.version,
    totalCredits: payload.totalCredits,
    settledAt: payload.settledAt,
    breakdown: payload.breakdown
      .map((kind) => {
        return {
          kind: kind.kind,
          credits: kind.credits,
          providers: [...kind.providers].sort((a, b) => {
            return a.provider.localeCompare(b.provider);
          }),
        };
      })
      .sort((a, b) => {
        return a.kind.localeCompare(b.kind);
      }),
  });
}

function usagePayloadEquals(
  left: ChatMessageUsagePayload,
  right: ChatMessageUsagePayload,
): boolean {
  return usagePayloadKey(left) === usagePayloadKey(right);
}

function usageMessageMatchesPayload(
  message: {
    readonly createdAt: Date;
    readonly usagePayload: ChatMessageUsagePayload | null;
  },
  payload: ChatMessageUsagePayload,
): boolean {
  const payloadCreatedAt = new Date(payload.settledAt);
  return (
    message.createdAt.getTime() === payloadCreatedAt.getTime() ||
    (message.usagePayload !== null &&
      usagePayloadEquals(message.usagePayload, payload))
  );
}

export const maybeEmitRunUsageMessage$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<boolean> => {
    const db = set(writeDb$);
    const emitted = await db.transaction(async (tx) => {
      // Multiple terminal side effects can attempt emission for the same run.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('chat_usage_message:' || ${runId}))`,
      );
      signal.throwIfAborted();

      const [context] = await tx
        .select({
          status: agentRuns.status,
          chatThreadId: zeroRuns.chatThreadId,
          userId: chatThreads.userId,
          pendingCount: sql<number>`COUNT(${usageEvent.id}) FILTER (WHERE ${usageEvent.status} = 'pending')::int`,
          processedCount: sql<number>`COUNT(${usageEvent.id}) FILTER (WHERE ${usageEvent.status} = 'processed')::int`,
          totalCredits: sql<number>`COALESCE(SUM(COALESCE(${usageEvent.creditsCharged}, 0)) FILTER (WHERE ${usageEvent.status} = 'processed'), 0)::bigint`,
          settledAt: sql<Date>`COALESCE(
            MAX(${usageEvent.processedAt}) FILTER (WHERE ${usageEvent.status} = 'processed'),
            MAX(${usageEvent.createdAt}) FILTER (WHERE ${usageEvent.status} = 'processed'),
            MAX(${agentRuns.completedAt}),
            MAX(${agentRuns.createdAt})
          )`,
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
      if (
        toNumber(context.pendingCount) > 0 ||
        toNumber(context.processedCount) === 0
      ) {
        return null;
      }

      const breakdownRows = await tx
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
        settledAt: toIsoString(context.settledAt),
        breakdown: buildUsageBreakdown(breakdownRows),
      };

      const existingUsageMessages = await tx
        .select({
          createdAt: chatMessages.createdAt,
          usagePayload: chatMessages.usagePayload,
        })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.runId, runId),
            sql`${chatMessages.usagePayload} IS NOT NULL`,
          ),
        );
      signal.throwIfAborted();

      const hasExistingPayload = existingUsageMessages.some((message) => {
        return usageMessageMatchesPayload(message, payload);
      });
      if (hasExistingPayload) {
        return null;
      }

      const [inserted] = await tx
        .insert(chatMessages)
        .values({
          chatThreadId: context.chatThreadId,
          role: "assistant",
          content: null,
          runId,
          usagePayload: payload,
          createdAt: new Date(payload.settledAt),
        })
        .returning({ id: chatMessages.id });
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
