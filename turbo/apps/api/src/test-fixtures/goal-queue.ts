import { storedExecutionContextSchema } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { threadGoals } from "@okouai/db/schema/thread-goal";
import { createStore } from "ccstate";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { pgTextDecoder } from "../lib/db-structured-result";
import { now } from "../lib/time";
import { ApiDispatchTimingCollector } from "../signals/services/api-dispatch-timing.service";
import {
  claimQueueFirstRunAssociation,
  lockGoalQueueFirstRunSource,
} from "../signals/services/chat-queued-event.service";
import { requirePiApiFirstTurnExecutionContext } from "../signals/services/pi-api-first-turn-config";
import { runPiApiFirstTurn$ } from "../signals/services/pi-api-first-turn.service";

import { db } from "../lib/db";
import { dispatchFailedRunCallbacks } from "../signals/services/agent-run-callback.service";
import {
  lockChatQueueThread,
  pendingChatQueueEventCondition,
} from "../signals/services/chat-event-queue.service";
import { insertChatEvent } from "../signals/services/chat-event.service";
import { appendGoalOpenMarker } from "../signals/services/chat-goal-marker.service";
import { drainChatThreadQueueForThread$ } from "../signals/services/chat-thread-queue-drain.service";
import { createUserMessageDocument } from "../signals/services/chat-user-message.service";

interface GoalQueueAdmissionFixtureArgs {
  readonly threadId: string;
  readonly goalId: string;
  readonly objectiveBrief: string;
}

/** Seed an old input: production no longer admits Goal events. */
export async function admitGoalQueueEventFixture(
  args: GoalQueueAdmissionFixtureArgs,
): Promise<
  | { readonly kind: "inserted"; readonly eventId: string }
  | { readonly kind: "coalesced" }
> {
  return await db().transaction(async (tx) => {
    await lockChatQueueThread(tx, args.threadId);
    const [pending] = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, args.threadId),
          eq(chatEvents.eventType, "input.goal"),
          pendingChatQueueEventCondition(tx),
        ),
      );
    if (pending) {
      return { kind: "coalesced" };
    }
    const event = await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "input.goal",
      content: null,
      contextType: "goal",
      runId: null,
      runGroupId: args.goalId,
      userMessage: createUserMessageDocument({
        text: null,
        nonContentPart: { type: "goal", goalBrief: args.objectiveBrief },
      }),
    });
    if (!event) {
      throw new Error("Expected an old Goal input fixture");
    }
    return { kind: "inserted", eventId: event.id };
  });
}

/** Persist a pre-retirement Goal on a thread created through the ordinary API. */
export async function seedGoalForRunFixture(
  runId: string,
  objective: string,
  status: "active" | "paused" | "blocked" | "complete" = "active",
): Promise<typeof threadGoals.$inferSelect> {
  const [run] = await db()
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      chatThreadId: agentRuns.chatThreadId,
      agentId: chatThreads.agentId,
    })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .where(eq(agentRuns.id, runId));
  const chatThreadId = run?.chatThreadId;
  const agentId = run?.agentId;
  if (!run || !chatThreadId || !agentId) {
    throw new Error(
      "Expected an owned thread run for the historical Goal fixture",
    );
  }
  return await db().transaction(async (tx) => {
    const [goal] = await tx
      .insert(threadGoals)
      .values({
        orgId: run.orgId,
        ownerUserId: run.userId,
        agentId,
        chatThreadId,
        status,
        objective,
        objectiveBrief: objective,
        autonomyBudget: 9,
      })
      .returning();
    if (!goal) {
      throw new Error("Expected a historical Goal fixture");
    }
    if (status === "active") {
      await appendGoalOpenMarker(tx, {
        chatThreadId: goal.chatThreadId,
        objectiveBrief: objective,
      });
    }
    return goal;
  });
}

/** Restore actual legacy provenance independently of the current Goal writer. */
export async function setLegacyGoalRunOriginFixture(
  runId: string,
  goalId: string,
  triggerSource: "goal" | "chat" = "goal",
): Promise<void> {
  await db()
    .update(agentRuns)
    .set({ goalId, triggerSource })
    .where(eq(agentRuns.id, runId));
}

/** Read queue source event ids and admitted goal-run ids for route assertions. */
export async function readGoalQueueStateFixture(threadId: string): Promise<{
  readonly eventIds: readonly string[];
  readonly runIds: readonly string[];
  readonly runs: readonly {
    readonly id: string;
    readonly goalId: string | null;
  }[];
}> {
  const [events, runs] = await Promise.all([
    db()
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, threadId),
          eq(chatEvents.eventType, "input.goal"),
        ),
      ),
    db()
      .select({
        id: agentRuns.id,
        goalId: agentRuns.goalId,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, threadId),
          isNotNull(agentRuns.goalId),
          isNotNull(agentRuns.triggerSource),
        ),
      ),
  ]);
  return {
    eventIds: events.map((event) => {
      return event.id;
    }),
    runIds: runs.map((run) => {
      return run.id;
    }),
    runs,
  };
}

/** Run the same shared scheduler that follows production goal admission. */
export async function drainChatThreadQueueFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
  readonly goalContinuationAdmitted?: boolean;
  readonly queueItemCreatedBefore?: Date;
}): Promise<void> {
  await createStore().set(
    drainChatThreadQueueForThread$,
    {
      chatThreadId: args.threadId,
      dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      ...(args.goalContinuationAdmitted === undefined
        ? {}
        : { goalContinuationAdmitted: args.goalContinuationAdmitted }),
      queueItemCreatedBefore: args.queueItemCreatedBefore,
    },
    args.signal,
  );
}

/** Move one goal trigger before a stale-sweep cutoff. */
export async function setGoalQueueEventCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date;
}): Promise<void> {
  const updated = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .update(chatEvents)
      .set({ createdAt: args.createdAt })
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.goal"),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one goal queue event to become historical");
  }
}

/** Invalidate a goal without triggering a separate queue drain. */
export async function pauseGoalQueueTargetFixture(
  goalId: string,
): Promise<void> {
  const [goal] = await db()
    .update(threadGoals)
    .set({ status: "paused" })
    .where(eq(threadGoals.id, goalId))
    .returning({ id: threadGoals.id });
  if (!goal) {
    throw new Error("Expected the goal queue target fixture");
  }
}

/**
 * Resolve the thread provisioned for a goal created from a non-chat run. The
 * goal API intentionally does not expose its backing thread id.
 */
export async function readGoalThreadFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId?: string;
  readonly threadId?: string;
}): Promise<{ readonly goalId: string; readonly threadId: string } | null> {
  const [goal] = await db()
    .select({
      goalId: threadGoals.id,
      threadId: threadGoals.chatThreadId,
    })
    .from(threadGoals)
    .where(
      and(
        eq(threadGoals.orgId, args.orgId),
        eq(threadGoals.ownerUserId, args.userId),
        args.agentId ? eq(threadGoals.agentId, args.agentId) : undefined,
        args.threadId ? eq(threadGoals.chatThreadId, args.threadId) : undefined,
      ),
    )
    .limit(1);
  return goal ?? null;
}

/**
 * Create an active goal and its pending internal trigger on an existing
 * automation thread. The product does not offer a cross-source setup endpoint;
 * this narrow fixture makes the shared queue-priority invariant observable.
 */
export async function createActiveGoalQueueEventFixture(args: {
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly objective: string;
  readonly objectiveBrief: string;
}): Promise<{ readonly goalId: string; readonly eventId: string }> {
  const [goal] = await db()
    .insert(threadGoals)
    .values({
      orgId: args.orgId,
      ownerUserId: args.userId,
      agentId: args.agentId,
      chatThreadId: args.threadId,
      status: "active",
      objective: args.objective,
      objectiveBrief: args.objectiveBrief,
    })
    .returning({ id: threadGoals.id });
  if (!goal) {
    throw new Error("Expected the active goal fixture");
  }
  const admission = await admitGoalQueueEventFixture({
    threadId: args.threadId,
    goalId: goal.id,
    objectiveBrief: args.objectiveBrief,
  });
  if (admission.kind !== "inserted") {
    throw new Error("Expected the goal fixture event to be inserted");
  }
  return { goalId: goal.id, eventId: admission.eventId };
}

/** Replay the final claim of a Goal prepared by an outgoing API instance. */
export async function claimPreparedGoalFixture(args: {
  readonly goal: typeof threadGoals.$inferSelect;
  readonly eventId: string;
  readonly runId: string;
}): Promise<"claimed" | "lost"> {
  return await db().transaction(async (tx) => {
    const [revision] = await tx
      .select({
        value: sql`${threadGoals.updatedAt}::text`.mapWith(pgTextDecoder),
      })
      .from(threadGoals)
      .where(eq(threadGoals.id, args.goal.id));
    if (!revision) {
      throw new Error("Expected the captured Goal revision");
    }
    const association = {
      kind: "goal_input" as const,
      threadId: args.goal.chatThreadId,
      eventId: args.eventId,
      prompt: "captured continuation",
      goalId: args.goal.id,
      goalObjectiveBrief: args.goal.objectiveBrief,
      goalStateRevision: revision.value,
      orgId: args.goal.orgId,
      userId: args.goal.ownerUserId,
    };
    await lockGoalQueueFirstRunSource(tx, association);
    await lockChatQueueThread(tx, association.threadId);
    const claim = await claimQueueFirstRunAssociation(tx, {
      ...association,
      admission: { kind: "idle" },
      runId: args.runId,
      selectedModel: null,
      timing: new ApiDispatchTimingCollector(),
    });
    return claim.kind;
  });
}

/** Invoke a captured API-owned Pi activation at its final execution entry. */
export async function activateLegacyGoalPiFixture(
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const [row] = await db()
    .select({ run: agentRuns, job: runnerJobQueue })
    .from(agentRuns)
    .innerJoin(runnerJobQueue, eq(agentRuns.id, runnerJobQueue.runId))
    .where(eq(agentRuns.id, runId));
  if (!row || !row.run.chatThreadId) {
    throw new Error("Expected a captured pending Goal job");
  }
  const startedAt = now();
  await createStore().set(
    runPiApiFirstTurn$,
    {
      runId,
      userId: row.run.userId,
      orgId: row.run.orgId,
      runnerGroup: row.job.runnerGroup,
      prompt: row.run.prompt,
      appendSystemPrompt: row.run.appendSystemPrompt,
      executionContext: requirePiApiFirstTurnExecutionContext({
        ...storedExecutionContextSchema.parse(row.job.executionContext),
        apiStartTime: startedAt,
        billableFirewalls: [],
        piSessionId: row.run.chatThreadId,
        piModelConfig: {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.6-terra",
          apiKeyEnv: "OPENAI_API_KEY",
          credentialSecretName: "OPENAI_API_KEY",
        },
        piLaunchConfig: {
          schemaVersion: 2,
          apiFirstTurn: {
            schemaVersion: 1,
            resourceSnapshotDigest: "a".repeat(64),
            manifestUrl: "https://storage.example/manifest.json",
            sessionUrl: "https://storage.example/session.jsonl",
            deadlineAt: startedAt + 55_000,
            baseSession: { sessionId: row.run.chatThreadId, sha256: null },
            sandboxEventSequenceStart: 1,
          },
        },
      }),
    },
    signal,
  );
}
