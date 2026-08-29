import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import type {
  GoalResponse,
  GoalStatus,
} from "@okouai/api-contracts/contracts/goals";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  threadGoals,
  type ThreadGoalStatus,
} from "@okouai/db/schema/thread-goal";
import { and, eq, isNotNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import {
  appendGoalCloseMarker,
  appendGoalOpenMarker,
} from "./chat-goal-marker.service";
import { normalizeGoalObjectiveBrief } from "./goal-objective-brief-normalization.service";
import { generateGoalObjectiveBrief } from "./goal-objective-brief.service";
import { lockGoalThread } from "./goal-lock.service";
import {
  appendChatThreadEvent,
  type ChatThreadEventTransaction,
} from "./chat-thread-event.service";
import {
  chatThreadModelPinColumns,
  resolveRequiredDefaultChatThreadModelPin,
} from "./chat-thread-model.service";
import { loadNewChatThreadMediaModels } from "./chat-thread-media-model.service";
import { childAutonomyBudget } from "./autonomy-budget.service";
import { threadGoalColumns } from "./autonomy-budget-schema.service";

export interface GoalBootstrap {
  readonly goalId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly objectiveBrief: string;
}

export type GoalResult =
  | {
      readonly kind: "ok";
      readonly goal: GoalResponse;
      readonly bootstrapGoal?: GoalBootstrap;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "bad-request"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "autonomy-budget-exhausted" };

type ClearGoalResult =
  | { readonly kind: "ok"; readonly cleared: true }
  | Exclude<GoalResult, { readonly kind: "ok" }>;

type GoalRow = typeof threadGoals.$inferSelect;

type GoalRowResult =
  | {
      readonly kind: "ok";
      readonly row: GoalRow;
      readonly threadId: string;
      readonly context: CurrentGoalContext;
    }
  | Exclude<GoalResult, { readonly kind: "ok" }>;

interface CurrentGoalContext {
  // Null when the current run is not linked to a web chat thread.
  readonly threadId: string | null;
  readonly agentId: string;
  readonly runGoalId: string | null;
  readonly autonomyBudget: number;
}

interface GoalAuth {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly capabilities: readonly Capability[];
}

function hasUserControlCapability(auth: GoalAuth): boolean {
  return auth.capabilities.some((capability) => {
    return capability === "goal:user-control:write";
  });
}

function goalResponse(row: GoalRow): GoalResponse {
  return {
    objective: row.objective,
    objectiveBrief: normalizeGoalObjectiveBrief({
      objective: row.objective,
      objectiveBrief: row.objectiveBrief,
    }),
    status: row.status as GoalStatus,
  };
}

async function currentGoalContext(
  db: ReadonlyDb,
  auth: Pick<GoalAuth, "orgId" | "userId" | "runId">,
): Promise<CurrentGoalContext | null> {
  const [row] = await db
    .select({
      threadId: agentRuns.chatThreadId,
      agentId: agents.id,
      runGoalId: agentRuns.goalId,
      autonomyBudget: agentRuns.autonomyBudget,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .innerJoin(agents, eq(agents.id, agentSessions.agentId))
    .where(
      and(
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.orgId, auth.orgId),
        eq(agentRuns.userId, auth.userId),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const autonomyBudget = row.autonomyBudget;
  if (autonomyBudget === null) {
    return null;
  }

  return { ...row, autonomyBudget };
}

async function loadGoalForThread(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly threadId: string },
): Promise<GoalRow | null> {
  const [row] = await db
    .select(threadGoalColumns())
    .from(threadGoals)
    .where(
      and(
        eq(threadGoals.orgId, args.orgId),
        eq(threadGoals.chatThreadId, args.threadId),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function loadActiveGoalForThread(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly threadId: string },
): Promise<GoalRow | null> {
  const goal = await loadGoalForThread(db, args);
  return goal?.status === "active" ? goal : null;
}

async function loadOwnedGoalForThread(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
): Promise<GoalRow | null> {
  const [row] = await db
    .select(threadGoalColumns())
    .from(threadGoals)
    .where(
      and(
        eq(threadGoals.orgId, args.orgId),
        eq(threadGoals.ownerUserId, args.userId),
        eq(threadGoals.chatThreadId, args.threadId),
      ),
    )
    .limit(1);

  return row ?? null;
}

async function insertGoal(
  tx: Pick<Db, "insert">,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly agentId: string;
    readonly chatThreadId: string;
    readonly objective: string;
    readonly objectiveBrief: string;
    readonly autonomyBudget: number;
    readonly createdAt: Date;
  },
): Promise<GoalRow> {
  const [goal] = await tx
    .insert(threadGoals)
    .values({
      orgId: args.orgId,
      ownerUserId: args.ownerUserId,
      agentId: args.agentId,
      chatThreadId: args.chatThreadId,
      status: "active",
      objective: args.objective,
      objectiveBrief: args.objectiveBrief,
      autonomyBudget: args.autonomyBudget,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
    })
    .returning(threadGoalColumns());
  if (!goal) {
    throw new Error("Failed to create thread goal");
  }
  return goal;
}

async function createGoalThread(
  tx: ChatThreadEventTransaction,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly agentId: string;
    readonly objective: string;
    readonly createdAt: Date;
  },
): Promise<string> {
  const pin = await resolveRequiredDefaultChatThreadModelPin(tx as Db, {
    orgId: args.orgId,
    userId: args.userId,
  });
  const mediaModels = await loadNewChatThreadMediaModels(tx, {
    orgId: args.orgId,
    userId: args.userId,
  });
  const pinColumns = chatThreadModelPinColumns(pin);
  const [thread] = await tx
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentId: args.agentId,
      title: args.objective,
      modelProviderId: pinColumns.modelProviderId,
      modelProviderType: pinColumns.modelProviderType,
      modelProviderCredentialScope: pinColumns.modelProviderCredentialScope,
      selectedModel: pinColumns.selectedModel,
      codexServiceTier: pin.serviceTier === "priority" ? "fast" : null,
      lastMessageAt: args.createdAt,
      createdAt: args.createdAt,
      updatedAt: args.createdAt,
      selectedVideoModel: mediaModels.selectedVideoModel,
      selectedImageModel: mediaModels.selectedImageModel,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create goal chat thread");
  }
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentId: args.agentId,
    title: args.objective,
    selectedModel: pin.selectedModel,
    serviceTier: pin.serviceTier,
    ...mediaModels,
    createdAt: thread.createdAt,
  });
  return thread.id;
}

async function setGoalStatus(
  tx: Pick<Db, "update">,
  args: {
    readonly goalId: string;
    readonly status: ThreadGoalStatus;
    readonly updatedAt: Date;
  },
): Promise<GoalRow> {
  const [goal] = await tx
    .update(threadGoals)
    .set({ status: args.status, updatedAt: args.updatedAt })
    .where(eq(threadGoals.id, args.goalId))
    .returning(threadGoalColumns());
  if (!goal) {
    throw new Error("Failed to update thread goal");
  }
  return goal;
}

async function reactivateGoal(
  tx: Pick<Db, "update">,
  args: {
    readonly goal: GoalRow;
    readonly autonomyBudget: number;
    readonly objective?: string;
    readonly objectiveBrief?: string;
    readonly updatedAt: Date;
  },
): Promise<GoalRow> {
  const [goal] = await tx
    .update(threadGoals)
    .set({
      status: "active",
      updatedAt: args.updatedAt,
      ...(args.objective === undefined ? {} : { objective: args.objective }),
      ...(args.objectiveBrief === undefined
        ? {}
        : { objectiveBrief: args.objectiveBrief }),
      autonomyBudget: args.autonomyBudget,
    })
    .where(eq(threadGoals.id, args.goal.id))
    .returning(threadGoalColumns());
  if (!goal) {
    throw new Error("Failed to reactivate thread goal");
  }
  return goal;
}

async function loadLockedOwnedGoal(
  tx: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly ownerUserId: string;
    readonly threadId: string;
  },
): Promise<GoalRow | null> {
  const current = await loadGoalForThread(tx, {
    orgId: args.orgId,
    threadId: args.threadId,
  });
  if (!current || current.ownerUserId !== args.ownerUserId) {
    return null;
  }
  return current;
}

async function publishGoalMarker(
  orgId: string,
  userId: string,
  threadId: string,
): Promise<void> {
  await publishChatThreadMessageCreatedSafely({ orgId, userId, threadId });
}

export async function createGoalForCurrentThread(
  db: Db,
  args: GoalAuth & {
    readonly objective: string;
  },
): Promise<GoalResult> {
  const context = await currentGoalContext(db, args);
  if (!context) {
    return {
      kind: "bad-request",
      message: "Current run is not linked to an agent",
    };
  }

  const derivedBudget = childAutonomyBudget(context.autonomyBudget);
  if (derivedBudget.kind === "exhausted") {
    return { kind: "autonomy-budget-exhausted" };
  }

  const createdAt = nowDate();
  const objectiveBrief = await generateGoalObjectiveBrief(args.objective);
  const isNewThread = context.threadId === null;

  const created = await db.transaction(async (tx) => {
    const threadId =
      context.threadId ??
      (await createGoalThread(tx, {
        userId: args.userId,
        orgId: args.orgId,
        agentId: context.agentId,
        objective: args.objective,
        createdAt,
      }));

    await lockGoalThread(tx, threadId);

    const existing = await loadGoalForThread(tx, {
      orgId: args.orgId,
      threadId,
    });
    if (existing && existing.status !== "complete") {
      return null;
    }
    if (existing) {
      await tx.delete(threadGoals).where(eq(threadGoals.id, existing.id));
    }

    const goal = await insertGoal(tx, {
      orgId: args.orgId,
      ownerUserId: args.userId,
      agentId: context.agentId,
      chatThreadId: threadId,
      objective: args.objective,
      objectiveBrief,
      autonomyBudget: derivedBudget.autonomyBudget,
      createdAt,
    });
    await appendGoalOpenMarker(tx, {
      chatThreadId: threadId,
      objectiveBrief,
    });
    return { goal, threadId };
  });

  if (!created) {
    return {
      kind: "conflict",
      message: "Clear or complete the existing goal before creating a new one",
    };
  }

  await publishGoalMarker(args.orgId, args.userId, created.threadId);

  return {
    kind: "ok",
    goal: goalResponse(created.goal),
    ...(isNewThread
      ? {
          bootstrapGoal: {
            goalId: created.goal.id,
            orgId: args.orgId,
            userId: args.userId,
            threadId: created.threadId,
            objectiveBrief: created.goal.objectiveBrief,
          },
        }
      : {}),
  };
}

export async function getCurrentGoal(
  db: ReadonlyDb,
  args: GoalAuth,
): Promise<GoalResult> {
  const context = await currentGoalContext(db, args);
  if (!context || context.threadId === null) {
    return {
      kind: "bad-request",
      message: "Current run is not linked to a chat thread",
    };
  }

  const goal = await loadGoalForThread(db, {
    orgId: args.orgId,
    threadId: context.threadId,
  });
  if (!goal) {
    return { kind: "not-found" };
  }

  return { kind: "ok", goal: goalResponse(goal) };
}

export async function getGoalForChatThread(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
): Promise<GoalResult> {
  const goal = await loadOwnedGoalForThread(db, args);
  if (!goal) {
    return { kind: "not-found" };
  }

  return { kind: "ok", goal: goalResponse(goal) };
}

export async function completeCurrentGoal(
  db: Db,
  args: GoalAuth,
): Promise<GoalResult> {
  return await setCurrentGoalTerminalState(db, args, "complete");
}

export async function blockCurrentGoal(
  db: Db,
  args: GoalAuth,
): Promise<GoalResult> {
  return await setCurrentGoalTerminalState(db, args, "blocked");
}

async function setCurrentGoalTerminalState(
  db: Db,
  args: GoalAuth,
  status: "blocked" | "complete",
): Promise<GoalResult> {
  const goal = await loadGoalForAuth(db, args, { requireFreshRunGoalId: true });
  if (goal.kind !== "ok") {
    return goal;
  }

  const updatedAt = nowDate();
  const updated = await db.transaction(async (tx) => {
    await lockGoalThread(tx, goal.threadId);
    const current = await loadGoalForThread(tx, {
      orgId: args.orgId,
      threadId: goal.threadId,
    });
    if (!current) {
      return null;
    }
    if (
      !hasUserControlCapability(args) &&
      goal.context.runGoalId !== null &&
      current.id !== goal.context.runGoalId
    ) {
      return "stale" as const;
    }
    const row = await setGoalStatus(tx, {
      goalId: current.id,
      status,
      updatedAt,
    });
    await appendGoalCloseMarker(tx, {
      chatThreadId: goal.threadId,
    });
    return row;
  });
  if (updated === null) {
    return { kind: "not-found" };
  }
  if (updated === "stale") {
    return {
      kind: "conflict",
      message: "The goal changed after this run started",
    };
  }

  await publishGoalMarker(args.orgId, args.userId, goal.threadId);
  return { kind: "ok", goal: goalResponse(updated) };
}

export async function pauseCurrentGoal(
  db: Db,
  args: GoalAuth,
): Promise<GoalResult> {
  const goal = await loadGoalForAuth(db, args, {
    requireFreshRunGoalId: false,
  });
  if (goal.kind !== "ok") {
    return goal;
  }
  return await pauseGoalRow(db, {
    orgId: args.orgId,
    userId: args.userId,
    threadId: goal.threadId,
    requireActive: false,
  });
}

export async function pauseGoalForChatThread(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
): Promise<GoalResult> {
  const goal = await loadOwnedGoalForThread(db, args);
  if (!goal) {
    return { kind: "not-found" };
  }
  return await pauseGoalRow(db, {
    orgId: args.orgId,
    userId: args.userId,
    threadId: args.threadId,
    requireActive: false,
  });
}

async function pauseGoalRow(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
    readonly requireActive: boolean;
  },
): Promise<GoalResult> {
  const pausedAt = nowDate();
  const updated = await db.transaction(async (tx) => {
    await lockGoalThread(tx, args.threadId);
    const current = await loadLockedOwnedGoal(tx, {
      orgId: args.orgId,
      ownerUserId: args.userId,
      threadId: args.threadId,
    });
    if (!current) {
      return null;
    }
    if (current.status === "complete") {
      return "complete" as const;
    }
    if (args.requireActive && current.status !== "active") {
      return null;
    }
    const row = await setGoalStatus(tx, {
      goalId: current.id,
      status: "paused",
      updatedAt: pausedAt,
    });
    await appendGoalCloseMarker(tx, {
      chatThreadId: args.threadId,
    });
    return row;
  });
  if (updated === null) {
    return { kind: "not-found" };
  }
  if (updated === "complete") {
    return {
      kind: "conflict",
      message: "Completed goals cannot be paused",
    };
  }
  await publishGoalMarker(args.orgId, args.userId, args.threadId);
  return { kind: "ok", goal: goalResponse(updated) };
}

export async function resumeCurrentGoal(
  db: Db,
  args: GoalAuth,
): Promise<GoalResult> {
  const goal = await loadGoalForAuth(db, args, {
    requireFreshRunGoalId: false,
  });
  if (goal.kind !== "ok") {
    return goal;
  }
  if (goal.row.status === "complete") {
    return {
      kind: "conflict",
      message: "Completed goals cannot be resumed",
    };
  }

  const reactivationBudget = childAutonomyBudget(goal.context.autonomyBudget);
  if (reactivationBudget.kind === "exhausted") {
    return { kind: "autonomy-budget-exhausted" };
  }

  const resumedAt = nowDate();
  const updated = await db.transaction(async (tx) => {
    await lockGoalThread(tx, goal.threadId);
    const current = await loadLockedOwnedGoal(tx, {
      orgId: args.orgId,
      ownerUserId: args.userId,
      threadId: goal.threadId,
    });
    if (!current) {
      return null;
    }
    if (current.status === "complete") {
      return "complete" as const;
    }
    const row = await reactivateGoal(tx, {
      goal: current,
      autonomyBudget: reactivationBudget.autonomyBudget,
      updatedAt: resumedAt,
    });
    await appendGoalOpenMarker(tx, {
      chatThreadId: goal.threadId,
      objectiveBrief: normalizeGoalObjectiveBrief({
        objective: current.objective,
        objectiveBrief: current.objectiveBrief,
      }),
    });
    return row;
  });
  if (updated === null) {
    return { kind: "not-found" };
  }
  if (updated === "complete") {
    return {
      kind: "conflict",
      message: "Completed goals cannot be resumed",
    };
  }
  await publishGoalMarker(args.orgId, args.userId, goal.threadId);
  return { kind: "ok", goal: goalResponse(updated) };
}

export async function editCurrentGoal(
  db: Db,
  args: GoalAuth & {
    readonly objective: string;
  },
): Promise<GoalResult> {
  const goal = await loadGoalForAuth(db, args, {
    requireFreshRunGoalId: false,
  });
  if (goal.kind !== "ok") {
    return goal;
  }

  const replacementBudget = childAutonomyBudget(goal.context.autonomyBudget);
  if (replacementBudget.kind === "exhausted") {
    return { kind: "autonomy-budget-exhausted" };
  }
  const editedAt = nowDate();
  const objectiveBrief = await generateGoalObjectiveBrief(args.objective);
  const updated = await db.transaction(async (tx) => {
    await lockGoalThread(tx, goal.threadId);
    const current = await loadLockedOwnedGoal(tx, {
      orgId: args.orgId,
      ownerUserId: args.userId,
      threadId: goal.threadId,
    });
    if (!current) {
      return null;
    }
    if (current.status === "complete") {
      await tx.delete(threadGoals).where(eq(threadGoals.id, current.id));
      const replacement = await insertGoal(tx, {
        orgId: args.orgId,
        ownerUserId: args.userId,
        agentId: current.agentId,
        chatThreadId: goal.threadId,
        objective: args.objective,
        objectiveBrief,
        autonomyBudget: replacementBudget.autonomyBudget,
        createdAt: editedAt,
      });
      await appendGoalOpenMarker(tx, {
        chatThreadId: goal.threadId,
        objectiveBrief,
      });
      return replacement;
    }

    const row = await reactivateGoal(tx, {
      goal: current,
      autonomyBudget: replacementBudget.autonomyBudget,
      objective: args.objective,
      objectiveBrief,
      updatedAt: editedAt,
    });
    await appendGoalOpenMarker(tx, {
      chatThreadId: goal.threadId,
      objectiveBrief,
    });
    return row;
  });
  if (!updated) {
    return { kind: "not-found" };
  }
  await publishGoalMarker(args.orgId, args.userId, goal.threadId);
  return { kind: "ok", goal: goalResponse(updated) };
}

export async function clearCurrentGoal(
  db: Db,
  args: GoalAuth,
): Promise<ClearGoalResult> {
  const goal = await loadGoalForAuth(db, args, {
    requireFreshRunGoalId: false,
  });
  if (goal.kind !== "ok") {
    return goal;
  }

  const cleared = await db.transaction(async (tx) => {
    await lockGoalThread(tx, goal.threadId);
    const current = await loadLockedOwnedGoal(tx, {
      orgId: args.orgId,
      ownerUserId: args.userId,
      threadId: goal.threadId,
    });
    if (!current) {
      return false;
    }
    await tx.delete(threadGoals).where(eq(threadGoals.id, current.id));
    await appendGoalCloseMarker(tx, {
      chatThreadId: goal.threadId,
    });
    return true;
  });
  if (!cleared) {
    return { kind: "not-found" };
  }
  await publishGoalMarker(args.orgId, args.userId, goal.threadId);
  return { kind: "ok", cleared: true };
}

export async function pauseActiveGoalForThread(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
): Promise<GoalResult> {
  const goal = await loadActiveGoalForThread(db, {
    orgId: args.orgId,
    threadId: args.threadId,
  });
  if (!goal) {
    return { kind: "not-found" };
  }
  return await pauseGoalRow(db, {
    orgId: args.orgId,
    userId: args.userId,
    threadId: args.threadId,
    requireActive: true,
  });
}

async function loadGoalForAuth(
  db: ReadonlyDb,
  args: GoalAuth,
  options: { readonly requireFreshRunGoalId: boolean },
): Promise<GoalRowResult> {
  const context = await currentGoalContext(db, args);
  if (!context || context.threadId === null) {
    return {
      kind: "bad-request",
      message: "Current run is not linked to a chat thread",
    };
  }

  const row = await loadGoalForThread(db, {
    orgId: args.orgId,
    threadId: context.threadId,
  });
  if (!row) {
    return { kind: "not-found" };
  }
  if (
    options.requireFreshRunGoalId &&
    !hasUserControlCapability(args) &&
    context.runGoalId !== row.id
  ) {
    return {
      kind: "conflict",
      message: "The goal changed after this run started",
    };
  }
  return { kind: "ok", row, threadId: context.threadId, context };
}
