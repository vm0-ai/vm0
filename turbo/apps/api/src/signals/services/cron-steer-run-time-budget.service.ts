import { command } from "ccstate";
import { and, eq, lte } from "drizzle-orm";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { zeroRuns } from "@okouai/db/schema/zero-run";

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
/**
 * A run leaves the window as soon as the runner terminates it at the hard
 * limit, so the scan only ever sees runs inside a five-minute band.
 */
const RUN_TIME_BUDGET_SCAN_LIMIT = 100;

const RUN_TIME_BUDGET_MESSAGE = `This runner has a hard maximum runtime of 2 hours. The current run has been active for 115 minutes, leaving approximately 5 minutes before it is terminated.

An active goal allows unfinished work to continue in a later run. An existing goal already provides that continuity and remains unchanged. If no goal exists, the unfinished outcome needs to be captured in a new goal before this run ends.

A normal completion provides a reliable handoff for the next run. The handoff includes completed work, current state, verification performed, remaining work, and blockers.

Use the remaining time to leave the task in a resumable state and finish this turn normally.`;

interface RunTimeBudgetCandidate {
  readonly runId: string;
  readonly chatThreadId: string;
}

async function loadRunTimeBudgetCandidates(
  db: Db,
  startedBefore: Date,
): Promise<readonly RunTimeBudgetCandidate[]> {
  return await db
    .select({
      runId: agentRuns.id,
      chatThreadId: chatThreads.id,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.status, "running"),
        lte(agentRuns.startedAt, startedBefore),
      ),
    )
    .orderBy(agentRuns.startedAt)
    .limit(RUN_TIME_BUDGET_SCAN_LIMIT);
}

/**
 * Insert the steer once per run. The event id is derived from the run id, so a
 * later scan of the same run conflicts on it instead of steering twice.
 */
async function persistRunTimeBudgetInput(
  db: Db,
  args: {
    readonly candidate: RunTimeBudgetCandidate;
    readonly startedBefore: Date;
    readonly createdAt: Date;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    if (!(await lockChatQueueThread(tx, args.candidate.chatThreadId))) {
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
          eq(agentRuns.id, args.candidate.runId),
          eq(agentRuns.status, "running"),
          eq(zeroRuns.chatThreadId, args.candidate.chatThreadId),
          lte(agentRuns.startedAt, args.startedBefore),
        ),
      )
      .for("update")
      .limit(1);
    if (!run?.chatThreadId) {
      return false;
    }

    const inserted = await insertChatEvent(
      tx,
      {
        id: runTimeBudgetEventIdForRun(args.candidate.runId),
        chatThreadId: run.chatThreadId,
        eventType: "input.budget",
        runId: null,
        userMessage: createUserMessageDocument({
          text: RUN_TIME_BUDGET_MESSAGE,
        }),
        agentRunContext: {
          sourceRunId: args.candidate.runId,
          sourceChatThreadId: run.chatThreadId,
          sourceAgentId: run.agentId,
        },
        createdAt: args.createdAt,
      },
      "id",
    );
    return inserted !== null;
  });
}

/**
 * Steer every chat run that reached its time budget. A run stays a candidate
 * until it ends, so an unclaimed steer is re-announced to the runner on the
 * next scan.
 */
export const steerRunsNearTimeBudget$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const createdAt = nowDate();
    const startedBefore = new Date(
      createdAt.getTime() - RUN_TIME_BUDGET_STEER_AT_MS,
    );
    const candidates = await loadRunTimeBudgetCandidates(db, startedBefore);
    signal.throwIfAborted();

    let steered = 0;
    for (const candidate of candidates) {
      if (
        await persistRunTimeBudgetInput(db, {
          candidate,
          startedBefore,
          createdAt,
        })
      ) {
        steered += 1;
      }
      signal.throwIfAborted();
      await notifyRunningChatRunOfPendingInput(db, candidate.chatThreadId);
      signal.throwIfAborted();
    }

    return { scanned: candidates.length, steered };
  },
);
