import { randomBytes } from "node:crypto";

import {
  zeroGoalPreferenceSchema,
  type ZeroGoalResponse,
} from "@vm0/api-contracts/contracts/zero-goals";
import { agentComposeVersions } from "@vm0/db/schema/agent-compose";
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
import { publishChatThreadAutomationsChangedSafely } from "../external/realtime";
import type { TriggerRow } from "./zero-workflow-trigger-run.service";

export type GoalResult =
  | {
      readonly kind: "ok";
      readonly goal: ZeroGoalResponse;
      // Set only when goal creation had to spin up a fresh chat thread (the
      // current run was not linked to one, e.g. slack/telegram/email). The
      // caller must kick off the first run so the goal starts progressing,
      // since the thread-idle trigger only fires after a run terminates.
      readonly bootstrapTrigger?: TriggerRow;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "bad-request"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string };

type GoalRowResult =
  | {
      readonly kind: "ok";
      readonly row: ActiveGoalRow;
      readonly threadId: string;
    }
  | Exclude<GoalResult, { readonly kind: "ok" }>;

interface CurrentGoalContext {
  // Null when the current run is not linked to a web chat thread (e.g. slack,
  // telegram, email triggers). Goal creation then provisions a new thread.
  readonly threadId: string | null;
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
  // Resolve the agent directly from the run's compose version so we still know
  // which agent to bind even when the run has no chat thread. zeroAgents.id,
  // chatThreads.agentComposeId and agentComposeVersions.composeId are all the
  // same compose UUID.
  const [row] = await db
    .select({
      threadId: zeroRuns.chatThreadId,
      agentId: agentComposeVersions.composeId,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .innerJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentRuns.agentComposeVersionId),
    )
    .where(
      and(
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.orgId, auth.orgId),
        eq(agentRuns.userId, auth.userId),
      ),
    )
    .limit(1);

  if (!row) {
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
      message: "Current run is not linked to an agent",
    };
  }

  const createdAt = nowDate();
  const preference = {
    version: 1 as const,
    objective: args.objective,
    ...(args.tokenBudget ? { tokenBudget: args.tokenBudget } : {}),
  };
  const isNewThread = context.threadId === null;

  const created = await db.transaction(async (tx) => {
    let threadId = context.threadId;
    if (threadId === null) {
      // Mirror the schedule-trigger path: when the current run has no chat
      // thread, provision one so the goal has a home to render its runs in.
      const [thread] = await tx
        .insert(chatThreads)
        .values({
          userId: args.userId,
          agentComposeId: context.agentId,
          title: args.objective,
          lastMessageAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: chatThreads.id });
      if (!thread) {
        throw new Error("Failed to create goal chat thread");
      }
      threadId = thread.id;
    }

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('goal:' || ${threadId}))`,
    );

    const existing = await loadActiveGoalForThread(tx, {
      orgId: args.orgId,
      threadId,
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
        chatThreadId: threadId,
        nextRunAt: null,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    if (!trigger) {
      throw new Error("Failed to create goal trigger");
    }

    return {
      row: {
        workflowId: workflow.id,
        triggerId: trigger.id,
        workflowActive: workflow.active,
        triggerEnabled: trigger.enabled,
        preference: workflow.preference,
      } satisfies ActiveGoalRow,
      trigger,
      threadId,
    };
  });

  if (!created) {
    return {
      kind: "conflict",
      message: "Complete the existing goal before creating a new one",
    };
  }

  // Refresh any client viewing the thread's automation sidebar so the new goal
  // shows up live (same realtime signal automations use).
  await publishChatThreadAutomationsChangedSafely(
    args.userId,
    created.threadId,
  );

  return {
    kind: "ok",
    goal: goalResponse(created.row),
    // A pre-existing thread already has an in-flight run that drives the first
    // continuation on completion; a freshly provisioned thread does not, so the
    // caller must bootstrap its first run.
    ...(isNewThread ? { bootstrapTrigger: created.trigger } : {}),
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
  await db.transaction(async (tx) => {
    await tx
      .update(zeroWorkflows)
      .set({ active: false, updatedAt: completedAt })
      .where(eq(zeroWorkflows.id, goal.row.workflowId));
    await tx
      .update(zeroWorkflowTriggers)
      .set({
        enabled: false,
        chatThreadId: null,
        nextRunAt: null,
        updatedAt: completedAt,
      })
      .where(eq(zeroWorkflowTriggers.id, goal.row.triggerId));
  });
  await publishChatThreadAutomationsChangedSafely(args.userId, goal.threadId);

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
  await publishChatThreadAutomationsChangedSafely(args.userId, goal.threadId);

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
  await publishChatThreadAutomationsChangedSafely(args.userId, goal.threadId);

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
  if (!context || context.threadId === null) {
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
  return { kind: "ok", row, threadId: context.threadId };
}
