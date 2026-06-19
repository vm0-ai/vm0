import { randomBytes } from "node:crypto";

import {
  zeroGoalPreferenceSchema,
  type ZeroGoalResponse,
} from "@vm0/api-contracts/contracts/zero-goals";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import { and, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";

export type GoalResult =
  | { readonly kind: "ok"; readonly goal: ZeroGoalResponse }
  | { readonly kind: "not-found" }
  | { readonly kind: "bad-request"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string };

type GoalRowResult =
  | { readonly kind: "ok"; readonly row: ActiveGoalRow }
  | Exclude<GoalResult, { readonly kind: "ok" }>;

interface CurrentGoalContext {
  readonly threadId: string;
  readonly agentId: string;
}

interface ActiveGoalRow {
  readonly workflowId: string;
  readonly triggerId: string;
  readonly workflowActive: boolean;
  readonly triggerEnabled: boolean;
  readonly preference: unknown;
}

interface GoalAuth {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}

function generatedGoalName(): string {
  return `goal-${randomBytes(8).toString("hex")}`;
}

function goalResponse(row: ActiveGoalRow): ZeroGoalResponse {
  const preference = zeroGoalPreferenceSchema.parse(row.preference);
  return {
    active: row.workflowActive,
    objective: preference.objective,
    status: row.workflowActive
      ? row.triggerEnabled
        ? "active"
        : "blocked"
      : "complete",
    ...(preference.tokenBudget ? { tokenBudget: preference.tokenBudget } : {}),
  };
}

async function currentGoalContext(
  db: ReadonlyDb,
  auth: GoalAuth,
): Promise<CurrentGoalContext | null> {
  const [row] = await db
    .select({
      threadId: zeroRuns.chatThreadId,
      agentId: chatThreads.agentComposeId,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.orgId, auth.orgId),
        eq(agentRuns.userId, auth.userId),
      ),
    )
    .limit(1);

  if (!row?.threadId) {
    return null;
  }
  return { threadId: row.threadId, agentId: row.agentId };
}

async function loadActiveGoalForThread(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly threadId: string },
): Promise<ActiveGoalRow | null> {
  const [row] = await db
    .select({
      workflowId: zeroWorkflows.id,
      triggerId: zeroWorkflowTriggers.id,
      workflowActive: zeroWorkflows.active,
      triggerEnabled: zeroWorkflowTriggers.enabled,
      preference: zeroWorkflows.preference,
    })
    .from(zeroWorkflowTriggers)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
    )
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, args.orgId),
        eq(zeroWorkflowTriggers.chatThreadId, args.threadId),
        eq(zeroWorkflowTriggers.kind, "event"),
        eq(zeroWorkflowTriggers.eventType, "thread-idle"),
        eq(zeroWorkflows.type, "goal"),
        eq(zeroWorkflows.active, true),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function createGoalForCurrentThread(
  db: Db,
  args: GoalAuth & {
    readonly objective: string;
    readonly tokenBudget?: number;
  },
): Promise<GoalResult> {
  const context = await currentGoalContext(db, args);
  if (!context) {
    return {
      kind: "bad-request",
      message: "Current run is not linked to a chat thread",
    };
  }

  const createdAt = nowDate();
  const preference = {
    version: 1 as const,
    objective: args.objective,
    ...(args.tokenBudget ? { tokenBudget: args.tokenBudget } : {}),
  };

  const row = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('goal:' || ${context.threadId}))`,
    );

    const existing = await loadActiveGoalForThread(tx, {
      orgId: args.orgId,
      threadId: context.threadId,
    });
    if (existing) {
      return null;
    }

    const [workflow] = await tx
      .insert(zeroWorkflows)
      .values({
        orgId: args.orgId,
        name: generatedGoalName(),
        visibility: "private",
        type: "goal",
        active: true,
        preference,
        ownerUserId: args.userId,
        displayName: "Goal",
        description: null,
        createdBy: args.userId,
        createdAt,
        updatedAt: createdAt,
      })
      .returning({
        id: zeroWorkflows.id,
        active: zeroWorkflows.active,
        preference: zeroWorkflows.preference,
      });
    if (!workflow) {
      throw new Error("Failed to create goal workflow");
    }

    const [trigger] = await tx
      .insert(zeroWorkflowTriggers)
      .values({
        orgId: args.orgId,
        workflowId: workflow.id,
        agentId: context.agentId,
        ownerUserId: args.userId,
        kind: "event",
        eventType: "thread-idle",
        scheduleType: null,
        cronExpression: null,
        intervalSeconds: null,
        atTime: null,
        timezone: "UTC",
        enabled: true,
        chatThreadId: context.threadId,
        nextRunAt: null,
        createdAt,
        updatedAt: createdAt,
      })
      .returning({
        id: zeroWorkflowTriggers.id,
        enabled: zeroWorkflowTriggers.enabled,
      });
    if (!trigger) {
      throw new Error("Failed to create goal trigger");
    }

    return {
      workflowId: workflow.id,
      triggerId: trigger.id,
      workflowActive: workflow.active,
      triggerEnabled: trigger.enabled,
      preference: workflow.preference,
    } satisfies ActiveGoalRow;
  });

  if (!row) {
    return {
      kind: "conflict",
      message: "Complete the existing goal before creating a new one",
    };
  }

  return { kind: "ok", goal: goalResponse(row) };
}

export async function getCurrentGoal(
  db: ReadonlyDb,
  args: GoalAuth,
): Promise<GoalResult> {
  const context = await currentGoalContext(db, args);
  if (!context) {
    return {
      kind: "bad-request",
      message: "Current run is not linked to a chat thread",
    };
  }

  const goal = await loadActiveGoalForThread(db, {
    orgId: args.orgId,
    threadId: context.threadId,
  });
  if (!goal) {
    return { kind: "not-found" };
  }

  return { kind: "ok", goal: goalResponse(goal) };
}

export async function completeCurrentGoal(
  db: Db,
  args: GoalAuth,
): Promise<GoalResult> {
  const goal = await loadGoalForAuth(db, args);
  if (goal.kind !== "ok") {
    return goal;
  }

  const completedAt = nowDate();
  await db
    .update(zeroWorkflows)
    .set({ active: false, updatedAt: completedAt })
    .where(eq(zeroWorkflows.id, goal.row.workflowId));

  return {
    kind: "ok",
    goal: { ...goalResponse(goal.row), active: false, status: "complete" },
  };
}

export async function blockCurrentGoal(
  db: Db,
  args: GoalAuth,
): Promise<GoalResult> {
  const goal = await loadGoalForAuth(db, args);
  if (goal.kind !== "ok") {
    return goal;
  }

  const blockedAt = nowDate();
  await db
    .update(zeroWorkflowTriggers)
    .set({ enabled: false, updatedAt: blockedAt })
    .where(eq(zeroWorkflowTriggers.id, goal.row.triggerId));

  return {
    kind: "ok",
    goal: { ...goalResponse(goal.row), active: true, status: "blocked" },
  };
}

export async function resumeCurrentGoal(
  db: Db,
  args: GoalAuth,
): Promise<GoalResult> {
  const goal = await loadGoalForAuth(db, args);
  if (goal.kind !== "ok") {
    return goal;
  }

  const resumedAt = nowDate();
  await db
    .update(zeroWorkflowTriggers)
    .set({ enabled: true, consecutiveFailures: 0, updatedAt: resumedAt })
    .where(eq(zeroWorkflowTriggers.id, goal.row.triggerId));

  return {
    kind: "ok",
    goal: { ...goalResponse(goal.row), active: true, status: "active" },
  };
}

async function loadGoalForAuth(
  db: ReadonlyDb,
  args: GoalAuth,
): Promise<GoalRowResult> {
  const context = await currentGoalContext(db, args);
  if (!context) {
    return {
      kind: "bad-request",
      message: "Current run is not linked to a chat thread",
    };
  }

  const row = await loadActiveGoalForThread(db, {
    orgId: args.orgId,
    threadId: context.threadId,
  });
  if (!row) {
    return { kind: "not-found" };
  }
  return { kind: "ok", row };
}
