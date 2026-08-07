import { command } from "ccstate";
import { and, eq, lte } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { runTimeBudgetEventIdForRun } from "./assistant-event-id";
import { lockChatQueueThread } from "./chat-event-queue.service";
import { notifyRunningChatRunOfPendingInput } from "./chat-thread-queue-drain.service";
import { insertChatEvent } from "./zero-chat-event.service";
import { createUserMessageDocument } from "./zero-chat-user-message.service";

const RUN_TIME_BUDGET_LIMIT_MS = 120 * 60 * 1000;
const RUN_TIME_BUDGET_REMAINING_MS = 5 * 60 * 1000;
const RUN_TIME_BUDGET_STEER_AT_MS =
  RUN_TIME_BUDGET_LIMIT_MS - RUN_TIME_BUDGET_REMAINING_MS;

const RUN_TIME_BUDGET_MESSAGE = `This runner has a hard maximum runtime of 2 hours. The current run has been active for 115 minutes, leaving approximately 5 minutes before it is terminated.

An active goal allows unfinished work to continue in a later run. An existing goal already provides that continuity and remains unchanged. If no goal exists, the unfinished outcome needs to be captured in a new goal before this run ends.

A normal completion provides a reliable handoff for the next run. The handoff includes completed work, current state, verification performed, remaining work, and blockers.

Use the remaining time to leave the task in a resumable state and finish this turn normally.`;

interface RunTimeBudgetCandidate {
  readonly chatThreadId: string;
}

async function loadRunTimeBudgetCandidate(
  db: Db,
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly startedBefore: Date;
  },
): Promise<RunTimeBudgetCandidate | null> {
  const [candidate] = await db
    .select({ chatThreadId: zeroRuns.chatThreadId })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.status, "running"),
        lte(agentRuns.startedAt, args.startedBefore),
      ),
    )
    .limit(1);
  return candidate?.chatThreadId
    ? { chatThreadId: candidate.chatThreadId }
    : null;
}

async function persistRunTimeBudgetInput(
  db: Db,
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly chatThreadId: string;
    readonly startedBefore: Date;
    readonly createdAt: Date;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    if (!(await lockChatQueueThread(tx, args.chatThreadId))) {
      return false;
    }
    const [run] = await tx
      .select({
        chatThreadId: zeroRuns.chatThreadId,
        agentId: chatThreads.agentComposeId,
      })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
      .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.status, "running"),
          eq(zeroRuns.chatThreadId, args.chatThreadId),
          lte(agentRuns.startedAt, args.startedBefore),
        ),
      )
      .for("update")
      .limit(1);
    if (!run?.chatThreadId) {
      return false;
    }

    await insertChatEvent(
      tx,
      {
        id: runTimeBudgetEventIdForRun(args.runId),
        chatThreadId: run.chatThreadId,
        eventType: "input.budget",
        runId: null,
        userMessage: createUserMessageDocument({
          text: RUN_TIME_BUDGET_MESSAGE,
        }),
        agentRunContext: {
          sourceRunId: args.runId,
          sourceChatThreadId: run.chatThreadId,
          sourceAgentId: run.agentId,
        },
        createdAt: args.createdAt,
      },
      "id",
    );
    return true;
  });
}

export const steerRunNearTimeBudget$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<{ status: 200 }> => {
    const payload = get(eventConsumerPayload$);
    const db = set(writeDb$);
    const createdAt = nowDate();
    const startedBefore = new Date(
      createdAt.getTime() - RUN_TIME_BUDGET_STEER_AT_MS,
    );
    const candidate = await loadRunTimeBudgetCandidate(db, {
      runId: payload.runId,
      userId: payload.context.userId,
      orgId: payload.context.orgId,
      startedBefore,
    });
    signal.throwIfAborted();
    if (!candidate) {
      return { status: 200 };
    }

    const persisted = await persistRunTimeBudgetInput(db, {
      runId: payload.runId,
      userId: payload.context.userId,
      orgId: payload.context.orgId,
      chatThreadId: candidate.chatThreadId,
      startedBefore,
      createdAt,
    });
    signal.throwIfAborted();
    if (persisted) {
      await notifyRunningChatRunOfPendingInput(db, candidate.chatThreadId);
      signal.throwIfAborted();
    }
    return { status: 200 };
  },
);
