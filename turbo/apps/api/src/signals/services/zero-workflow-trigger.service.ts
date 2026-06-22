import { command } from "ccstate";
import type { ChatThreadWorkflowTrigger } from "@vm0/api-contracts/contracts/automations";
import type {
  ZeroWorkflowSchedule,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
  type ZeroWorkflowScheduleType,
} from "@vm0/db/schema/zero-workflow";
import { and, asc, eq, isNotNull } from "drizzle-orm";

import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  publishChatThreadAutomationsChangedSafely,
  publishChatThreadMessageCreatedSafely,
} from "../external/realtime";
import { nowDate } from "../../lib/time";
import { isValidTimeZone, safeSync } from "../utils";
import { calculateNextRun } from "./automations/time-trigger";
import {
  GOAL_TRIGGER_ACTIVE_EVENT_ID,
  GOAL_TRIGGER_INACTIVE_EVENT_ID,
  appendGoalStateMarker,
} from "./zero-chat-goal-marker.service";
import { fireWorkflowTriggerTestRun$ } from "./zero-workflow-trigger-poller.service";
import {
  loadVisibleWorkflowById,
  type WorkflowMember,
} from "./zero-workflow-data.service";

type TriggerRow = typeof zeroWorkflowTriggers.$inferSelect;

/**
 * Outcome of a trigger mutation, mapped to an HTTP response by the route layer.
 */
export type TriggerResult =
  | { readonly kind: "ok"; readonly summary: ZeroWorkflowTriggerSummary }
  | { readonly kind: "deleted" }
  | { readonly kind: "not-found" }
  | { readonly kind: "forbidden"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "bad-request"; readonly message: string };

interface ScheduleColumns {
  readonly scheduleType: ZeroWorkflowScheduleType;
  readonly cronExpression: string | null;
  readonly intervalSeconds: number | null;
  readonly atTime: Date | null;
  readonly timezone: string;
}

function scheduleToColumns(schedule: ZeroWorkflowSchedule): ScheduleColumns {
  if (schedule.type === "cron") {
    return {
      scheduleType: "cron",
      cronExpression: schedule.cronExpression,
      intervalSeconds: null,
      atTime: null,
      timezone: schedule.timezone,
    };
  }
  if (schedule.type === "once") {
    return {
      scheduleType: "once",
      cronExpression: null,
      intervalSeconds: null,
      atTime: new Date(schedule.atTime),
      timezone: schedule.timezone,
    };
  }
  return {
    scheduleType: "loop",
    cronExpression: null,
    intervalSeconds: schedule.intervalSeconds,
    atTime: null,
    timezone: "UTC",
  };
}

/**
 * Validate the schedule against the current time. Returns an error message, or
 * null when the schedule is valid. `intervalSeconds` is already constrained to
 * a positive integer by the contract.
 */
function validateSchedule(
  schedule: ZeroWorkflowSchedule,
  now: Date,
): string | null {
  if (schedule.type === "loop") {
    return null;
  }
  if (!isValidTimeZone(schedule.timezone)) {
    return `Invalid timezone: ${schedule.timezone}`;
  }
  if (schedule.type === "once") {
    if (new Date(schedule.atTime).getTime() <= now.getTime()) {
      return "Schedule atTime must be in the future";
    }
    return null;
  }
  const next = safeSync(() => {
    return calculateNextRun(schedule.cronExpression, schedule.timezone, now);
  });
  if ("error" in next) {
    return `Invalid cron expression: ${schedule.cronExpression}`;
  }
  if (next.ok === null) {
    return `Cron expression has no future occurrences: ${schedule.cronExpression}`;
  }
  return null;
}

/**
 * First/next fire time for a newly created or (re-)enabled trigger. A disabled
 * trigger is not scheduled. The poller advances cron/loop recurrence after each
 * run; this only seeds the first run.
 */
function resolveNextRunAt(
  schedule: ZeroWorkflowSchedule,
  enabled: boolean,
  now: Date,
): Date | null {
  if (!enabled) {
    return null;
  }
  if (schedule.type === "cron") {
    return calculateNextRun(schedule.cronExpression, schedule.timezone, now);
  }
  if (schedule.type === "once") {
    return new Date(schedule.atTime);
  }
  return now;
}

function summarizeSchedule(schedule: ZeroWorkflowSchedule): string {
  if (schedule.type === "cron") {
    return `${schedule.cronExpression} (${schedule.timezone})`;
  }
  if (schedule.type === "loop") {
    return `Every ${schedule.intervalSeconds}s`;
  }
  return `Once at ${schedule.atTime}`;
}

function rowToSchedule(row: TriggerRow): ZeroWorkflowSchedule {
  if (row.kind !== "schedule" || row.scheduleType === null) {
    throw new Error(`Workflow trigger is not a schedule trigger: ${row.id}`);
  }
  if (row.scheduleType === "cron") {
    return {
      type: "cron",
      cronExpression: row.cronExpression ?? "",
      timezone: row.timezone,
    };
  }
  if (row.scheduleType === "loop") {
    return { type: "loop", intervalSeconds: row.intervalSeconds ?? 0 };
  }
  return {
    type: "once",
    atTime: (row.atTime ?? new Date(0)).toISOString(),
    timezone: row.timezone,
  };
}

function rowToSummary(row: TriggerRow): ZeroWorkflowTriggerSummary {
  const schedule = rowToSchedule(row);
  return {
    id: row.id,
    kind: "schedule",
    schedule,
    scheduleSummary: summarizeSchedule(schedule),
    ownerUserId: row.ownerUserId,
    enabled: row.enabled,
    chatThreadId: row.chatThreadId,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
  };
}

interface UsableAgent {
  readonly id: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
}

async function loadAgent(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly agentId: string },
): Promise<UsableAgent | null> {
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
    })
    .from(zeroAgents)
    .where(
      and(eq(zeroAgents.orgId, args.orgId), eq(zeroAgents.id, args.agentId)),
    )
    .limit(1);
  return agent ?? null;
}

/**
 * A trigger run executes as its owner, so the owner must be able to run the
 * workflow's owning agent: public agents are runnable by any member, private
 * agents only by their owner. This is a "use" gate, not the agent "manage" gate.
 */
function canUseAgent(agent: UsableAgent, member: WorkflowMember): boolean {
  return agent.visibility === "public" || agent.owner === member.userId;
}

/**
 * Resolve the workflow's single owning agent for a trigger. Under 1:N the agent
 * is derived from `zero_workflows.agent_id`, not from the trigger row.
 */
async function loadTriggerWorkflowAgentId(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly workflowId: string },
): Promise<string | null> {
  const [workflow] = await db
    .select({ agentId: zeroWorkflows.agentId })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, args.orgId),
        eq(zeroWorkflows.id, args.workflowId),
      ),
    )
    .limit(1);
  return workflow?.agentId ?? null;
}

async function loadTriggerRow(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly triggerId: string },
): Promise<TriggerRow | null> {
  const [row] = await db
    .select()
    .from(zeroWorkflowTriggers)
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, args.orgId),
        eq(zeroWorkflowTriggers.id, args.triggerId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * List the caller's own schedule triggers under a workflow. Detail pages show
 * only the triggers the caller owns, so this filters by `ownerUserId`.
 * Visibility of the workflow itself is the caller's responsibility (the workflow
 * must already be resolved as visible).
 */
export async function loadWorkflowTriggers(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly workflowId: string;
    readonly userId: string;
  },
): Promise<readonly ZeroWorkflowTriggerSummary[]> {
  const rows = await db
    .select()
    .from(zeroWorkflowTriggers)
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, args.orgId),
        eq(zeroWorkflowTriggers.workflowId, args.workflowId),
        eq(zeroWorkflowTriggers.ownerUserId, args.userId),
        eq(zeroWorkflowTriggers.kind, "schedule"),
      ),
    )
    .orderBy(asc(zeroWorkflowTriggers.createdAt));
  return rows.map(rowToSummary);
}

/**
 * List every workflow trigger (schedule or goal/event) the caller owns that is
 * bound to a chat thread, joined with its workflow's identity + description.
 * Surfaced alongside automations so the chat-thread automation list shows the
 * recurring workflows/goals attached to the thread. Filtered to the open thread
 * client-side via `chatThreadId`.
 */
export async function listChatThreadWorkflowTriggers(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
): Promise<readonly ChatThreadWorkflowTrigger[]> {
  const rows = await db
    .select({ trigger: zeroWorkflowTriggers, workflow: zeroWorkflows })
    .from(zeroWorkflowTriggers)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
    )
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, args.orgId),
        eq(zeroWorkflowTriggers.ownerUserId, args.userId),
        isNotNull(zeroWorkflowTriggers.chatThreadId),
      ),
    )
    .orderBy(asc(zeroWorkflowTriggers.createdAt));

  return rows.flatMap(({ trigger, workflow }) => {
    if (trigger.chatThreadId === null) {
      return [];
    }
    return [
      {
        id: trigger.id,
        kind: trigger.kind,
        scheduleSummary:
          trigger.kind === "schedule"
            ? summarizeSchedule(rowToSchedule(trigger))
            : null,
        eventType: trigger.eventType,
        enabled: trigger.enabled,
        chatThreadId: trigger.chatThreadId,
        nextRunAt: trigger.nextRunAt ? trigger.nextRunAt.toISOString() : null,
        lastRunAt: trigger.lastRunAt ? trigger.lastRunAt.toISOString() : null,
        workflow: {
          id: workflow.id,
          name: workflow.name,
          displayName: workflow.displayName,
          description: workflow.description,
          // A goal carries no `description`; its human text is the objective in
          // `preference`. Surface it separately so the UI can show it.
          objective: workflow.preference?.objective ?? null,
          type: workflow.type,
        },
      },
    ];
  });
}

/**
 * Enable or disable a chat-thread-bound workflow or goal trigger (the rows the
 * automation sidebar lists). Owner-scoped. Schedule triggers reseed/clear their
 * next run; event (goal) triggers just flip `enabled`. Publishes the realtime
 * automations-changed signal so open sidebars refresh.
 */
export async function setChatThreadWorkflowTriggerEnabled(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly triggerId: string;
    readonly enabled: boolean;
  },
): Promise<"ok" | "not-found"> {
  const [trigger] = await db
    .select()
    .from(zeroWorkflowTriggers)
    .where(
      and(
        eq(zeroWorkflowTriggers.id, args.triggerId),
        eq(zeroWorkflowTriggers.orgId, args.orgId),
        eq(zeroWorkflowTriggers.ownerUserId, args.userId),
      ),
    )
    .limit(1);
  if (!trigger) {
    return "not-found";
  }

  const now = nowDate();
  const nextRunAt =
    trigger.kind === "schedule"
      ? args.enabled
        ? resolveNextRunAt(rowToSchedule(trigger), true, now)
        : null
      : trigger.nextRunAt;

  await db
    .update(zeroWorkflowTriggers)
    .set({
      enabled: args.enabled,
      nextRunAt,
      ...(args.enabled ? { consecutiveFailures: 0 } : {}),
      updatedAt: now,
    })
    .where(eq(zeroWorkflowTriggers.id, args.triggerId));

  if (trigger.chatThreadId) {
    // For a goal trigger, the sidebar toggle is the same active/inactive
    // transition the goal API makes — publish it into the thread so the
    // composer's folded goal state stays in sync.
    const [workflow] = await db
      .select({ type: zeroWorkflows.type })
      .from(zeroWorkflows)
      .where(eq(zeroWorkflows.id, trigger.workflowId))
      .limit(1);
    if (workflow?.type === "goal") {
      await appendGoalStateMarker(db, {
        chatThreadId: trigger.chatThreadId,
        eventId: args.enabled
          ? GOAL_TRIGGER_ACTIVE_EVENT_ID
          : GOAL_TRIGGER_INACTIVE_EVENT_ID,
        content: args.enabled ? args.triggerId : null,
      });
      await publishChatThreadMessageCreatedSafely(
        args.userId,
        trigger.chatThreadId,
      );
    }
    await publishChatThreadAutomationsChangedSafely(
      args.userId,
      trigger.chatThreadId,
    );
  }
  return "ok";
}

/**
 * Load a single trigger if its workflow is visible to the caller. Read-only;
 * does not require ownership.
 */
export async function getWorkflowTrigger(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly triggerId: string;
  },
): Promise<ZeroWorkflowTriggerSummary | null> {
  const trigger = await loadTriggerRow(db, {
    orgId: args.orgId,
    triggerId: args.triggerId,
  });
  if (!trigger) {
    return null;
  }
  if (trigger.kind !== "schedule") {
    return null;
  }
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: trigger.workflowId,
  });
  if (!visible) {
    return null;
  }
  return rowToSummary(trigger);
}

interface CreateTriggerInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly schedule: ZeroWorkflowSchedule;
  readonly enabled: boolean;
}

export const createWorkflowTrigger$ = command(
  async (
    { set },
    args: CreateTriggerInput,
    signal: AbortSignal,
  ): Promise<TriggerResult> => {
    const writeDb = set(writeDb$);
    const visible = await loadVisibleWorkflowById(writeDb, {
      orgId: args.orgId,
      member: args.member,
      workflowId: args.workflowId,
    });
    signal.throwIfAborted();
    if (!visible) {
      return { kind: "not-found" };
    }
    const { workflow } = visible;

    // The owning agent is derived from the workflow row (hard 1:N). The trigger
    // owner must be able to run that agent for the scheduled run to fire.
    const agent = await loadAgent(writeDb, {
      orgId: args.orgId,
      agentId: workflow.agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return {
        kind: "bad-request",
        message: `Agent not found: ${workflow.agentId}`,
      };
    }
    if (!canUseAgent(agent, args.member)) {
      return {
        kind: "forbidden",
        message: "You do not have access to the workflow's agent",
      };
    }

    const now = nowDate();
    const scheduleError = validateSchedule(args.schedule, now);
    if (scheduleError) {
      return { kind: "bad-request", message: scheduleError };
    }

    const cols = scheduleToColumns(args.schedule);
    const nextRunAt = resolveNextRunAt(args.schedule, args.enabled, now);

    const summary = await writeDb.transaction(async (tx) => {
      const [thread] = await tx
        .insert(chatThreads)
        .values({
          userId: args.member.userId,
          agentComposeId: agent.id,
          title: summarizeSchedule(args.schedule),
          lastMessageAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: chatThreads.id });
      if (!thread) {
        throw new Error("Failed to create trigger chat thread");
      }

      const [row] = await tx
        .insert(zeroWorkflowTriggers)
        .values({
          orgId: args.orgId,
          workflowId: workflow.id,
          ownerUserId: args.member.userId,
          kind: "schedule",
          eventType: null,
          scheduleType: cols.scheduleType,
          cronExpression: cols.cronExpression,
          intervalSeconds: cols.intervalSeconds,
          atTime: cols.atTime,
          timezone: cols.timezone,
          enabled: args.enabled,
          chatThreadId: thread.id,
          nextRunAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) {
        throw new Error("Failed to create workflow trigger");
      }
      return rowToSummary(row);
    });
    signal.throwIfAborted();
    return { kind: "ok", summary };
  },
);

interface OwnedTrigger {
  readonly trigger: TriggerRow;
}

async function loadOwnedTrigger(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly triggerId: string;
  },
): Promise<OwnedTrigger | TriggerResult> {
  const trigger = await loadTriggerRow(db, {
    orgId: args.orgId,
    triggerId: args.triggerId,
  });
  if (!trigger) {
    return { kind: "not-found" };
  }
  if (trigger.kind !== "schedule") {
    return { kind: "not-found" };
  }
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: trigger.workflowId,
  });
  if (!visible) {
    return { kind: "not-found" };
  }
  if (trigger.ownerUserId !== args.member.userId) {
    return {
      kind: "forbidden",
      message: "Only the trigger owner can manage this trigger",
    };
  }
  return { trigger };
}

interface UpdateTriggerInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly triggerId: string;
  readonly schedule: ZeroWorkflowSchedule;
}

export const updateWorkflowTrigger$ = command(
  async (
    { set },
    args: UpdateTriggerInput,
    signal: AbortSignal,
  ): Promise<TriggerResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedTrigger(writeDb, {
      orgId: args.orgId,
      member: args.member,
      triggerId: args.triggerId,
    });
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const { trigger } = owned;

    const now = nowDate();
    const scheduleError = validateSchedule(args.schedule, now);
    if (scheduleError) {
      return { kind: "bad-request", message: scheduleError };
    }
    const cols = scheduleToColumns(args.schedule);
    const nextRunAt = resolveNextRunAt(args.schedule, trigger.enabled, now);

    const [row] = await writeDb
      .update(zeroWorkflowTriggers)
      .set({
        scheduleType: cols.scheduleType,
        cronExpression: cols.cronExpression,
        intervalSeconds: cols.intervalSeconds,
        atTime: cols.atTime,
        timezone: cols.timezone,
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(zeroWorkflowTriggers.id, trigger.id))
      .returning();
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Failed to update workflow trigger");
    }
    return { kind: "ok", summary: rowToSummary(row) };
  },
);

interface TriggerActionInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly triggerId: string;
}

export const deleteWorkflowTrigger$ = command(
  async (
    { set },
    args: TriggerActionInput,
    signal: AbortSignal,
  ): Promise<TriggerResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedTrigger(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    // Delete the trigger row only; the bound chat thread is kept.
    await writeDb
      .delete(zeroWorkflowTriggers)
      .where(eq(zeroWorkflowTriggers.id, owned.trigger.id));
    signal.throwIfAborted();
    return { kind: "deleted" };
  },
);

export const enableWorkflowTrigger$ = command(
  async (
    { set },
    args: TriggerActionInput,
    signal: AbortSignal,
  ): Promise<TriggerResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedTrigger(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const { trigger } = owned;

    // The owning agent is derived from the workflow row (hard 1:N); it always
    // exists. Re-confirm the owner can still run it before re-enabling.
    const agentId = await loadTriggerWorkflowAgentId(writeDb, {
      orgId: args.orgId,
      workflowId: trigger.workflowId,
    });
    signal.throwIfAborted();
    if (agentId === null) {
      return { kind: "not-found" };
    }
    const agent = await loadAgent(writeDb, {
      orgId: args.orgId,
      agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return {
        kind: "conflict",
        message: "Cannot enable: the workflow's agent no longer exists.",
      };
    }
    if (!canUseAgent(agent, args.member)) {
      return {
        kind: "forbidden",
        message: "You do not have access to the workflow's agent",
      };
    }

    const now = nowDate();
    const nextRunAt = resolveNextRunAt(rowToSchedule(trigger), true, now);
    const [row] = await writeDb
      .update(zeroWorkflowTriggers)
      .set({ enabled: true, nextRunAt, consecutiveFailures: 0, updatedAt: now })
      .where(eq(zeroWorkflowTriggers.id, trigger.id))
      .returning();
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Failed to enable workflow trigger");
    }
    return { kind: "ok", summary: rowToSummary(row) };
  },
);

export const disableWorkflowTrigger$ = command(
  async (
    { set },
    args: TriggerActionInput,
    signal: AbortSignal,
  ): Promise<TriggerResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedTrigger(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const now = nowDate();
    const [row] = await writeDb
      .update(zeroWorkflowTriggers)
      .set({ enabled: false, nextRunAt: null, updatedAt: now })
      .where(eq(zeroWorkflowTriggers.id, owned.trigger.id))
      .returning();
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Failed to disable workflow trigger");
    }
    return { kind: "ok", summary: rowToSummary(row) };
  },
);

/**
 * Outcome of a manual test run. A test run fires the workflow into the bound
 * thread without claiming or advancing the schedule.
 */
type WorkflowTriggerTestRunResult =
  | { readonly kind: "ok"; readonly runId: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "forbidden"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string }
  | {
      readonly kind: "run_error";
      readonly response: {
        readonly status: number;
        readonly body: {
          readonly error: { readonly message: string; readonly code: string };
        };
      };
    };

export const testRunWorkflowTrigger$ = command(
  async (
    { set },
    args: TriggerActionInput,
    signal: AbortSignal,
  ): Promise<WorkflowTriggerTestRunResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedTrigger(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned.kind === "forbidden"
        ? { kind: "forbidden", message: owned.message }
        : { kind: "not-found" };
    }
    const { trigger } = owned;

    if (!trigger.chatThreadId) {
      return {
        kind: "conflict",
        message: "Cannot run: the trigger has no bound chat thread.",
      };
    }

    const [workflow] = await writeDb
      .select({ name: zeroWorkflows.name, agentId: zeroWorkflows.agentId })
      .from(zeroWorkflows)
      .where(eq(zeroWorkflows.id, trigger.workflowId))
      .limit(1);
    signal.throwIfAborted();
    if (!workflow) {
      return { kind: "not-found" };
    }

    const result = await set(
      fireWorkflowTriggerTestRun$,
      {
        trigger,
        agentId: workflow.agentId,
        workflowName: workflow.name,
        apiStartTime: nowDate().getTime(),
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "ok") {
      return { kind: "ok", runId: result.runId };
    }
    if (result.kind === "conflict") {
      return { kind: "conflict", message: result.message };
    }
    return { kind: "run_error", response: result.response };
  },
);
