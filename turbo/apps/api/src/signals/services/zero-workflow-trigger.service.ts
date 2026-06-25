import { command } from "ccstate";
import {
  gmailNewMessageEventConfigSchema,
  type ChatThreadWorkflowTrigger,
  type GmailNewMessageEventConfig,
  type UnattendedTriggerPermissionPolicy,
  type ZeroWorkflowSchedule,
  type ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { loadFirewallPermissionIndex } from "@vm0/connectors/firewall-metadata/server";
import { parseScheduledAtTime } from "@vm0/core/timezone";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  zeroWorkflowTriggers,
  zeroWorkflows,
  type ZeroWorkflowScheduleType,
} from "@vm0/db/schema/zero-workflow";
import { and, asc, eq } from "drizzle-orm";

import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { publishChatThreadAutomationsChangedSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { isValidTimeZone, safeSync } from "../utils";
import { calculateNextRun } from "./automations/time-trigger";
import {
  loadVisibleWorkflowById,
  type WorkflowMember,
} from "./zero-workflow-data.service";
import {
  ensureGmailWatchForUser,
  gmailWorkflowEventTriggersEnabledForOwner,
} from "./gmail-workflow-event.service";

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

function parseOnceAtTime(
  schedule: Extract<ZeroWorkflowSchedule, { type: "once" }>,
): Date {
  const result = parseScheduledAtTime(schedule.atTime, schedule.timezone);
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.date;
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
      atTime: parseOnceAtTime(schedule),
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
    const atTime = parseScheduledAtTime(schedule.atTime, schedule.timezone);
    if (!atTime.ok) {
      return atTime.message;
    }
    if (atTime.date.getTime() <= now.getTime()) {
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
    return parseOnceAtTime(schedule);
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
  if (row.kind === "event" && row.eventType === "gmail-new-message") {
    return {
      id: row.id,
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: gmailNewMessageEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
      ownerUserId: row.ownerUserId,
      enabled: row.enabled,
      chatThreadId: row.chatThreadId,
      nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      unattendedPermissionPolicy: row.unattendedPermissionPolicy ?? null,
    };
  }
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
    unattendedPermissionPolicy: row.unattendedPermissionPolicy ?? null,
  };
}

function rowToPublicSummary(
  row: TriggerRow,
): ZeroWorkflowTriggerSummary | null {
  if (row.kind === "event" && row.eventType !== "gmail-new-message") {
    return null;
  }
  return rowToSummary(row);
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
 * List the caller's own workflow triggers under a workflow. Detail pages show
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
      ),
    )
    .orderBy(asc(zeroWorkflowTriggers.createdAt));
  return rows.flatMap((row) => {
    const summary = rowToPublicSummary(row);
    return summary ? [summary] : [];
  });
}

/**
 * List workflow triggers the caller owns that are bound to a chat thread,
 * joined with the workflow identity needed by the chat sidebar.
 */
export async function listThreadBoundWorkflowTriggers(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
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
        eq(zeroWorkflowTriggers.chatThreadId, args.threadId),
      ),
    )
    .orderBy(asc(zeroWorkflowTriggers.createdAt));

  return rows.flatMap(({ trigger, workflow }) => {
    const summary = rowToPublicSummary(trigger);
    if (!summary || trigger.chatThreadId === null) {
      return [];
    }
    return [
      {
        id: summary.id,
        kind: summary.kind,
        scheduleSummary: summary.scheduleSummary,
        eventType: summary.kind === "event" ? summary.eventType : null,
        enabled: summary.enabled,
        chatThreadId: trigger.chatThreadId,
        nextRunAt: summary.nextRunAt,
        lastRunAt: summary.lastRunAt,
        workflow: {
          id: workflow.id,
          name: workflow.name,
          displayName: workflow.displayName,
          description: workflow.description,
        },
      },
    ];
  });
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
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: trigger.workflowId,
  });
  if (!visible) {
    return null;
  }
  return rowToPublicSummary(trigger);
}

interface CreateScheduleTriggerInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly schedule: ZeroWorkflowSchedule;
  readonly enabled: boolean;
}

interface CreateGmailEventTriggerInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: "gmail-new-message";
  readonly eventConfig: GmailNewMessageEventConfig;
  readonly enabled: boolean;
}

type CreateTriggerInput =
  | CreateScheduleTriggerInput
  | CreateGmailEventTriggerInput;

function triggerCreateInputIsSchedule(
  args: CreateTriggerInput,
): args is CreateScheduleTriggerInput {
  return "schedule" in args;
}

async function ensureAgentGmailConnector(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
): Promise<void> {
  await db
    .insert(userConnectors)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
      connectorType: "gmail",
    })
    .onConflictDoNothing({
      target: [
        userConnectors.orgId,
        userConnectors.userId,
        userConnectors.agentId,
        userConnectors.connectorType,
      ],
    });
}

async function insertGmailEventTrigger(
  db: Db,
  args: {
    readonly input: CreateGmailEventTriggerInput;
    readonly workflowId: string;
    readonly agentId: string;
    readonly currentTime: Date;
  },
): Promise<ZeroWorkflowTriggerSummary> {
  return await db.transaction(async (tx) => {
    await ensureAgentGmailConnector(tx, {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      agentId: args.agentId,
    });

    const [thread] = await tx
      .insert(chatThreads)
      .values({
        userId: args.input.member.userId,
        agentComposeId: args.agentId,
        title: "Gmail new message",
        lastMessageAt: args.currentTime,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Failed to create trigger chat thread");
    }

    const [row] = await tx
      .insert(zeroWorkflowTriggers)
      .values({
        orgId: args.input.orgId,
        workflowId: args.workflowId,
        ownerUserId: args.input.member.userId,
        kind: "event",
        eventType: args.input.eventType,
        eventConfig: args.input.eventConfig,
        scheduleType: null,
        cronExpression: null,
        intervalSeconds: null,
        atTime: null,
        timezone: "UTC",
        enabled: args.input.enabled,
        chatThreadId: thread.id,
        nextRunAt: null,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to create workflow trigger");
    }
    return rowToSummary(row);
  });
}

async function insertScheduleTrigger(
  db: Db,
  args: {
    readonly input: CreateScheduleTriggerInput;
    readonly workflowId: string;
    readonly agentId: string;
    readonly columns: ScheduleColumns;
    readonly nextRunAt: Date | null;
    readonly currentTime: Date;
  },
): Promise<ZeroWorkflowTriggerSummary> {
  return await db.transaction(async (tx) => {
    const [thread] = await tx
      .insert(chatThreads)
      .values({
        userId: args.input.member.userId,
        agentComposeId: args.agentId,
        title: summarizeSchedule(args.input.schedule),
        lastMessageAt: args.currentTime,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Failed to create trigger chat thread");
    }

    const [row] = await tx
      .insert(zeroWorkflowTriggers)
      .values({
        orgId: args.input.orgId,
        workflowId: args.workflowId,
        ownerUserId: args.input.member.userId,
        kind: "schedule",
        eventType: null,
        eventConfig: null,
        scheduleType: args.columns.scheduleType,
        cronExpression: args.columns.cronExpression,
        intervalSeconds: args.columns.intervalSeconds,
        atTime: args.columns.atTime,
        timezone: args.columns.timezone,
        enabled: args.input.enabled,
        chatThreadId: thread.id,
        nextRunAt: args.nextRunAt,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to create workflow trigger");
    }
    return rowToSummary(row);
  });
}

export const createWorkflowTrigger$ = command(
  async (
    { get, set },
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

    if (!triggerCreateInputIsSchedule(args)) {
      const featureEnabled = await get(
        gmailWorkflowEventTriggersEnabledForOwner(
          args.orgId,
          args.member.userId,
        ),
      );
      signal.throwIfAborted();
      if (!featureEnabled) {
        return {
          kind: "bad-request",
          message: "Gmail workflow event triggers are not enabled",
        };
      }

      const watchResult = await ensureGmailWatchForUser({
        db: writeDb,
        orgId: args.orgId,
        userId: args.member.userId,
        signal,
      });
      signal.throwIfAborted();
      if (watchResult.kind !== "ok") {
        return { kind: "bad-request", message: watchResult.message };
      }

      const summary = await insertGmailEventTrigger(writeDb, {
        input: args,
        workflowId: workflow.id,
        agentId: agent.id,
        currentTime: nowDate(),
      });
      signal.throwIfAborted();
      return { kind: "ok", summary };
    }

    const now = nowDate();
    const scheduleError = validateSchedule(args.schedule, now);
    if (scheduleError) {
      return { kind: "bad-request", message: scheduleError };
    }

    const cols = scheduleToColumns(args.schedule);
    const nextRunAt = resolveNextRunAt(args.schedule, args.enabled, now);

    const summary = await insertScheduleTrigger(writeDb, {
      input: args,
      workflowId: workflow.id,
      agentId: agent.id,
      columns: cols,
      nextRunAt,
      currentTime: now,
    });
    signal.throwIfAborted();
    return { kind: "ok", summary };
  },
);

interface OwnedTrigger {
  readonly trigger: TriggerRow;
}

async function publishThreadBoundWorkflowTriggerChanged(
  userId: string,
  chatThreadId: string | null,
): Promise<void> {
  if (chatThreadId === null) {
    return;
  }
  await publishChatThreadAutomationsChangedSafely(userId, chatThreadId);
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
  if (trigger.kind === "event" && trigger.eventType !== "gmail-new-message") {
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
  readonly schedule?: ZeroWorkflowSchedule;
  readonly eventConfig?: GmailNewMessageEventConfig;
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

    if (trigger.kind === "event") {
      if (args.eventConfig === undefined) {
        return {
          kind: "bad-request",
          message: "eventConfig is required for Gmail event triggers",
        };
      }
      const [row] = await writeDb
        .update(zeroWorkflowTriggers)
        .set({ eventConfig: args.eventConfig, updatedAt: nowDate() })
        .where(eq(zeroWorkflowTriggers.id, trigger.id))
        .returning();
      signal.throwIfAborted();
      if (!row) {
        throw new Error("Failed to update workflow trigger");
      }
      return { kind: "ok", summary: rowToSummary(row) };
    }

    if (args.schedule === undefined) {
      return {
        kind: "bad-request",
        message: "schedule is required for schedule triggers",
      };
    }
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

interface SetTriggerPermissionPolicyInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly triggerId: string;
  readonly policy: UnattendedTriggerPermissionPolicy | null;
}

/**
 * Validates connector refs and permission names against the generated firewall
 * metadata (the same source the user-permission-grants apply path validates
 * against). `ask` is already rejected by the contract schema, and the unknown
 * pseudo-permission is intentionally not accepted: a trigger's unknown-endpoint
 * policy is not configurable and always resolves to `deny`.
 */
async function validateUnattendedPermissionPolicy(
  policy: UnattendedTriggerPermissionPolicy,
): Promise<{ readonly kind: "bad-request"; readonly message: string } | null> {
  for (const [connectorRef, entry] of Object.entries(policy)) {
    const index = await loadFirewallPermissionIndex(connectorRef);
    if (!index) {
      return {
        kind: "bad-request",
        message: `Unknown connector ref: ${connectorRef}`,
      };
    }
    for (const permission of Object.keys(entry.policies)) {
      if (!index.hasPermission(permission)) {
        return {
          kind: "bad-request",
          message: `Unknown permission "${permission}" for connector "${connectorRef}"`,
        };
      }
    }
  }
  return null;
}

export const setWorkflowTriggerPermissionPolicy$ = command(
  async (
    { set },
    args: SetTriggerPermissionPolicyInput,
    signal: AbortSignal,
  ): Promise<TriggerResult> => {
    if (args.policy !== null) {
      const policyError = await validateUnattendedPermissionPolicy(args.policy);
      signal.throwIfAborted();
      if (policyError) {
        return policyError;
      }
    }
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
    const [row] = await writeDb
      .update(zeroWorkflowTriggers)
      .set({ unattendedPermissionPolicy: args.policy, updatedAt: nowDate() })
      .where(eq(zeroWorkflowTriggers.id, owned.trigger.id))
      .returning();
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Failed to update workflow trigger permission policy");
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
    await publishThreadBoundWorkflowTriggerChanged(
      args.member.userId,
      owned.trigger.chatThreadId,
    );
    signal.throwIfAborted();
    return { kind: "deleted" };
  },
);

export const enableWorkflowTrigger$ = command(
  async (
    { get, set },
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
    const nextRunAt =
      trigger.kind === "schedule"
        ? resolveNextRunAt(rowToSchedule(trigger), true, now)
        : trigger.nextRunAt;
    if (trigger.kind === "event") {
      const featureEnabled = await get(
        gmailWorkflowEventTriggersEnabledForOwner(
          args.orgId,
          args.member.userId,
        ),
      );
      signal.throwIfAborted();
      if (!featureEnabled) {
        return {
          kind: "bad-request",
          message: "Gmail workflow event triggers are not enabled",
        };
      }

      const agentId = await loadTriggerWorkflowAgentId(writeDb, {
        orgId: args.orgId,
        workflowId: trigger.workflowId,
      });
      signal.throwIfAborted();
      if (agentId === null) {
        return { kind: "not-found" };
      }
      const watchResult = await ensureGmailWatchForUser({
        db: writeDb,
        orgId: args.orgId,
        userId: args.member.userId,
        signal,
      });
      signal.throwIfAborted();
      if (watchResult.kind !== "ok") {
        return { kind: "bad-request", message: watchResult.message };
      }
      await ensureAgentGmailConnector(writeDb, {
        orgId: args.orgId,
        userId: args.member.userId,
        agentId,
      });
      signal.throwIfAborted();
    }
    const [row] = await writeDb
      .update(zeroWorkflowTriggers)
      .set({ enabled: true, nextRunAt, consecutiveFailures: 0, updatedAt: now })
      .where(eq(zeroWorkflowTriggers.id, trigger.id))
      .returning();
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Failed to enable workflow trigger");
    }
    await publishThreadBoundWorkflowTriggerChanged(
      args.member.userId,
      row.chatThreadId,
    );
    signal.throwIfAborted();
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
    const nextRunAt =
      owned.trigger.kind === "schedule" ? null : owned.trigger.nextRunAt;
    const [row] = await writeDb
      .update(zeroWorkflowTriggers)
      .set({ enabled: false, nextRunAt, updatedAt: now })
      .where(eq(zeroWorkflowTriggers.id, owned.trigger.id))
      .returning();
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Failed to disable workflow trigger");
    }
    await publishThreadBoundWorkflowTriggerChanged(
      args.member.userId,
      row.chatThreadId,
    );
    signal.throwIfAborted();
    return { kind: "ok", summary: rowToSummary(row) };
  },
);
