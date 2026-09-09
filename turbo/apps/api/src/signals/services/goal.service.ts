import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import type {
  GoalResponse,
  GoalStatus,
} from "@okouai/api-contracts/contracts/goals";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agents } from "@okouai/db/schema/agent";
import {
  threadGoals,
  type ThreadGoalStatus,
} from "@okouai/db/schema/thread-goal";
import { and, eq, isNotNull } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { appendGoalCloseMarker } from "./chat-goal-marker.service";
import { normalizeGoalObjectiveBrief } from "./goal-objective-brief-normalization.service";
import { lockGoalThread } from "./goal-lock.service";
import { threadGoalColumns } from "./autonomy-budget-schema.service";

import { GOAL_RETIRED_MESSAGE } from "./goal-retirement.service";

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

  return { kind: "conflict", message: GOAL_RETIRED_MESSAGE };
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
  if (goal.row.ownerUserId !== args.userId) {
    return { kind: "not-found" };
  }
  return { kind: "conflict", message: GOAL_RETIRED_MESSAGE };
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
  if (goal.row.ownerUserId !== args.userId) {
    return { kind: "not-found" };
  }
  return { kind: "conflict", message: GOAL_RETIRED_MESSAGE };
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
