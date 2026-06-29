import { command } from "ccstate";
import {
  gmailLabelAppliedEventConfigSchema,
  gmailNewMessageEventConfigSchema,
  githubLabelAppliedEventConfigSchema,
  webhookReceivedEventConfigSchema,
  type ChatThreadWorkflowTrigger,
  type GmailWorkflowEventConfig,
  type GithubWorkflowEventConfig,
  type WebhookReceivedEventConfig,
  type ZeroWorkflowEventType,
  type ZeroWorkflowSchedule,
  type ZeroWorkflowTriggerAutomationEntry,
  type ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { parseScheduledAtTime } from "@vm0/core/timezone";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  workflowUserTriggerThreads,
  zeroWorkflowTriggers,
  zeroWorkflowWebhookTriggers,
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
  visibleWorkflowCondition,
  workflowSummary,
  type WorkflowMember,
} from "./zero-workflow-data.service";
import {
  ensureGmailWatchForUser,
  gmailWorkflowEventTriggersEnabledForOwner,
  resolveGmailLabelForUser,
} from "./gmail-workflow-event.service";
import {
  prepareGithubLabelEventConfigForPersist,
  workflowGithubLabelEventTriggersEnabledForOwner,
} from "./github-workflow-event.service";
import {
  buildWorkflowWebhookSummaryFields,
  defaultWebhookReceivedEventConfig,
  encryptWorkflowWebhookSecret,
  encryptWorkflowWebhookToken,
  hashWorkflowWebhookToken,
  mintWorkflowWebhookSecret,
  mintWorkflowWebhookToken,
  workflowWebhookTriggersEnabledForOwner,
} from "./workflow-webhook-trigger.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  buildChatOnlyWorkflowTriggerCallbacks,
  runWorkflowTriggerNow$,
  type RunWorkflowTriggerResult,
} from "./zero-workflow-trigger-run.service";
import {
  ensureWorkflowUserTriggerThread,
  loadWorkflowUserTriggerThreadId,
} from "./zero-workflow-user-trigger-thread.service";

type TriggerRow = typeof zeroWorkflowTriggers.$inferSelect;
type GmailWorkflowEventType = Extract<
  ZeroWorkflowEventType,
  "gmail-new-message" | "gmail-label-applied"
>;
type GithubWorkflowEventType = Extract<
  ZeroWorkflowEventType,
  "github-label-applied"
>;

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
type TriggerActionFailure = Exclude<
  TriggerResult,
  { readonly kind: "ok" } | { readonly kind: "deleted" }
>;
type WorkflowTriggerRunNowResult =
  | {
      readonly kind: "ok";
      readonly runId: string;
      readonly chatThreadId: string;
    }
  | TriggerActionFailure
  | Exclude<RunWorkflowTriggerResult, { readonly kind: "ok" }>;

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
  lastRunAt: Date | null = null,
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
  return resolveLoopNextRunAt(schedule.intervalSeconds, now, lastRunAt);
}

function resolveLoopNextRunAt(
  intervalSeconds: number,
  now: Date,
  lastRunAt: Date | null,
): Date {
  if (!lastRunAt) {
    return now;
  }
  const nextFromLastRun = new Date(
    lastRunAt.getTime() + intervalSeconds * 1000,
  );
  return nextFromLastRun.getTime() > now.getTime() ? nextFromLastRun : now;
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

function supportedWorkflowEventType(
  eventType: string | null,
): eventType is ZeroWorkflowEventType {
  return (
    eventType === "gmail-new-message" ||
    eventType === "gmail-label-applied" ||
    eventType === "github-label-applied" ||
    eventType === "webhook-received"
  );
}

function supportedGmailEventType(
  eventType: string | null,
): eventType is GmailWorkflowEventType {
  return (
    eventType === "gmail-new-message" || eventType === "gmail-label-applied"
  );
}

function supportedGithubEventType(
  eventType: string | null,
): eventType is GithubWorkflowEventType {
  return eventType === "github-label-applied";
}

function rowSummaryBase(row: TriggerRow, chatThreadId: string | null) {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    enabled: row.enabled,
    chatThreadId,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
  };
}

async function rowToSummary(
  db: ReadonlyDb,
  row: TriggerRow,
  options: {
    readonly chatThreadId?: string | null;
    readonly webhookSecret?: string;
  } = {},
): Promise<ZeroWorkflowTriggerSummary> {
  const chatThreadId =
    "chatThreadId" in options
      ? (options.chatThreadId ?? null)
      : await loadWorkflowUserTriggerThreadId(db, {
          orgId: row.orgId,
          userId: row.ownerUserId,
          workflowId: row.workflowId,
        });
  if (row.kind === "event" && row.eventType === "gmail-new-message") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: gmailNewMessageEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.kind === "event" && row.eventType === "gmail-label-applied") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: gmailLabelAppliedEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.kind === "event" && row.eventType === "github-label-applied") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "github-label-applied",
      eventConfig: githubLabelAppliedEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.kind === "event" && row.eventType === "webhook-received") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "webhook-received",
      eventConfig: webhookReceivedEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
      ...(await buildWorkflowWebhookSummaryFields(db, {
        trigger: row,
        webhookSecret: options.webhookSecret,
      })),
    };
  }
  const schedule = rowToSchedule(row);
  return {
    ...rowSummaryBase(row, chatThreadId),
    kind: "schedule",
    schedule,
    scheduleSummary: summarizeSchedule(schedule),
  };
}

async function rowToPublicSummary(
  db: ReadonlyDb,
  row: TriggerRow,
  options: { readonly chatThreadId?: string | null } = {},
): Promise<ZeroWorkflowTriggerSummary | null> {
  if (row.kind === "event" && !supportedWorkflowEventType(row.eventType)) {
    return null;
  }
  return await rowToSummary(db, row, options);
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

async function loadTriggerWorkflowRunTarget(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly workflowId: string },
): Promise<{
  readonly agentId: string;
  readonly workflowName: string;
  readonly workflowTitle: string;
} | null> {
  const [workflow] = await db
    .select({
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      workflowDisplayName: zeroWorkflows.displayName,
    })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, args.orgId),
        eq(zeroWorkflows.id, args.workflowId),
      ),
    )
    .limit(1);
  if (!workflow) {
    return null;
  }
  return {
    agentId: workflow.agentId,
    workflowName: workflow.workflowName,
    workflowTitle: workflow.workflowDisplayName ?? workflow.workflowName,
  };
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
  const chatThreadId = await loadWorkflowUserTriggerThreadId(db, {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.workflowId,
  });
  const summaries = await Promise.all(
    rows.map((row) => {
      return rowToPublicSummary(db, row, { chatThreadId });
    }),
  );
  return summaries.flatMap((summary) => {
    return summary ? [summary] : [];
  });
}

/**
 * List the caller's workflow triggers across every visible workflow in one
 * lightweight projection for the /automations surface. This deliberately avoids
 * workflow detail loading, so it does not read workflow volume files from R2.
 */
export async function listWorkspaceWorkflowTriggers(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
  },
): Promise<readonly ZeroWorkflowTriggerAutomationEntry[]> {
  const rows = await db
    .select({
      trigger: zeroWorkflowTriggers,
      workflow: zeroWorkflows,
      agent: {
        id: zeroAgents.id,
        owner: zeroAgents.owner,
        visibility: zeroAgents.visibility,
        name: zeroAgents.name,
        displayName: zeroAgents.displayName,
      },
      chatThreadId: workflowUserTriggerThreads.chatThreadId,
    })
    .from(zeroWorkflowTriggers)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowTriggers.workflowId),
    )
    .innerJoin(zeroAgents, eq(zeroAgents.id, zeroWorkflows.agentId))
    .leftJoin(
      workflowUserTriggerThreads,
      and(
        eq(workflowUserTriggerThreads.orgId, zeroWorkflowTriggers.orgId),
        eq(workflowUserTriggerThreads.userId, zeroWorkflowTriggers.ownerUserId),
        eq(
          workflowUserTriggerThreads.workflowId,
          zeroWorkflowTriggers.workflowId,
        ),
      ),
    )
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, args.orgId),
        eq(zeroWorkflowTriggers.ownerUserId, args.member.userId),
        visibleWorkflowCondition(args.member),
      ),
    )
    .orderBy(asc(zeroWorkflowTriggers.createdAt), asc(zeroWorkflowTriggers.id));

  const entries = await Promise.all(
    rows.map(
      async (row): Promise<ZeroWorkflowTriggerAutomationEntry | null> => {
        const trigger = await rowToPublicSummary(db, row.trigger, {
          chatThreadId: row.chatThreadId ?? null,
        });
        if (!trigger) {
          return null;
        }
        return {
          workflow: workflowSummary({
            workflow: row.workflow,
            agent: row.agent,
            member: args.member,
          }),
          trigger,
        };
      },
    ),
  );
  return entries.flatMap((entry) => {
    return entry ? [entry] : [];
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
    .select({
      trigger: zeroWorkflowTriggers,
      workflow: zeroWorkflows,
      chatThreadId: workflowUserTriggerThreads.chatThreadId,
    })
    .from(zeroWorkflowTriggers)
    .innerJoin(
      workflowUserTriggerThreads,
      and(
        eq(workflowUserTriggerThreads.orgId, zeroWorkflowTriggers.orgId),
        eq(workflowUserTriggerThreads.userId, zeroWorkflowTriggers.ownerUserId),
        eq(
          workflowUserTriggerThreads.workflowId,
          zeroWorkflowTriggers.workflowId,
        ),
      ),
    )
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
    )
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, args.orgId),
        eq(zeroWorkflowTriggers.ownerUserId, args.userId),
        eq(workflowUserTriggerThreads.chatThreadId, args.threadId),
      ),
    )
    .orderBy(asc(zeroWorkflowTriggers.createdAt));

  const summaries = await Promise.all(
    rows.map(async ({ trigger, workflow, chatThreadId }) => {
      const summary = await rowToPublicSummary(db, trigger, { chatThreadId });
      return { workflow, summary, chatThreadId };
    }),
  );

  return summaries.flatMap<ChatThreadWorkflowTrigger>(
    ({
      workflow,
      summary,
      chatThreadId,
    }): readonly ChatThreadWorkflowTrigger[] => {
      if (!summary || chatThreadId === null) {
        return [];
      }
      const base = {
        id: summary.id,
        enabled: summary.enabled,
        chatThreadId,
        nextRunAt: summary.nextRunAt,
        lastRunAt: summary.lastRunAt,
        ownerUserId: summary.ownerUserId,
        workflow: {
          id: workflow.id,
          agentId: workflow.agentId,
          name: workflow.name,
          displayName: workflow.displayName,
          description: workflow.description,
        },
      };
      if (summary.kind === "schedule") {
        return [
          {
            ...base,
            kind: "schedule",
            schedule: summary.schedule,
            scheduleSummary: summary.scheduleSummary,
          },
        ];
      }
      if (summary.kind !== "event") {
        return [];
      }
      if (summary.eventType === "gmail-new-message") {
        return [
          {
            ...base,
            kind: "event",
            eventType: "gmail-new-message",
            eventConfig: summary.eventConfig,
            schedule: null,
            scheduleSummary: null,
          },
        ];
      }
      if (summary.eventType === "gmail-label-applied") {
        return [
          {
            ...base,
            kind: "event",
            eventType: "gmail-label-applied",
            eventConfig: summary.eventConfig,
            schedule: null,
            scheduleSummary: null,
          },
        ];
      }
      if (summary.eventType === "github-label-applied") {
        return [
          {
            ...base,
            kind: "event",
            eventType: "github-label-applied",
            eventConfig: summary.eventConfig,
            schedule: null,
            scheduleSummary: null,
          },
        ];
      }
      return [];
    },
  );
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
  return await rowToPublicSummary(db, trigger);
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
  readonly eventType: GmailWorkflowEventType;
  readonly eventConfig: GmailWorkflowEventConfig;
  readonly enabled: boolean;
}

interface CreateGithubEventTriggerInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: GithubWorkflowEventType;
  readonly eventConfig: GithubWorkflowEventConfig;
  readonly enabled: boolean;
}

interface CreateWebhookEventTriggerInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: "webhook-received";
  readonly eventConfig?: WebhookReceivedEventConfig;
  readonly enabled: boolean;
}

type CreateTriggerInput =
  | CreateScheduleTriggerInput
  | CreateGmailEventTriggerInput
  | CreateGithubEventTriggerInput
  | CreateWebhookEventTriggerInput;
type CreateEventTriggerInput = Exclude<
  CreateTriggerInput,
  CreateScheduleTriggerInput
>;

function triggerCreateInputIsSchedule(
  args: CreateTriggerInput,
): args is CreateScheduleTriggerInput {
  return "schedule" in args;
}

async function insertWorkflowEventTrigger(
  db: Db,
  args: {
    readonly input:
      | CreateGmailEventTriggerInput
      | CreateGithubEventTriggerInput;
    readonly workflowId: string;
    readonly agentId: string;
    readonly workflowTitle: string;
    readonly currentTime: Date;
  },
): Promise<ZeroWorkflowTriggerSummary> {
  return await db.transaction(async (tx) => {
    const chatThreadId = await ensureWorkflowUserTriggerThread(tx, {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      workflowId: args.workflowId,
      agentId: args.agentId,
      workflowTitle: args.workflowTitle,
      currentTime: args.currentTime,
    });

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
        nextRunAt: null,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to create workflow trigger");
    }
    return await rowToSummary(tx, row, { chatThreadId });
  });
}

async function insertWebhookEventTrigger(
  db: Db,
  args: {
    readonly input: CreateWebhookEventTriggerInput;
    readonly workflowId: string;
    readonly agentId: string;
    readonly workflowTitle: string;
    readonly currentTime: Date;
  },
): Promise<ZeroWorkflowTriggerSummary> {
  return await db.transaction(async (tx) => {
    const chatThreadId = await ensureWorkflowUserTriggerThread(tx, {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      workflowId: args.workflowId,
      agentId: args.agentId,
      workflowTitle: args.workflowTitle,
      currentTime: args.currentTime,
    });

    const [row] = await tx
      .insert(zeroWorkflowTriggers)
      .values({
        orgId: args.input.orgId,
        workflowId: args.workflowId,
        ownerUserId: args.input.member.userId,
        kind: "event",
        eventType: args.input.eventType,
        eventConfig:
          args.input.eventConfig ?? defaultWebhookReceivedEventConfig(),
        scheduleType: null,
        cronExpression: null,
        intervalSeconds: null,
        atTime: null,
        timezone: "UTC",
        enabled: args.input.enabled,
        nextRunAt: null,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to create workflow trigger");
    }

    const token = mintWorkflowWebhookToken();
    const secret = mintWorkflowWebhookSecret();
    await tx.insert(zeroWorkflowWebhookTriggers).values({
      triggerId: row.id,
      tokenHash: hashWorkflowWebhookToken(token),
      encryptedToken: await encryptWorkflowWebhookToken(token, {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
      }),
      encryptedSecret: await encryptWorkflowWebhookSecret(secret, {
        orgId: args.input.orgId,
        userId: args.input.member.userId,
      }),
      secretLastFour: secret.slice(-4),
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
    });

    return await rowToSummary(tx, row, { chatThreadId, webhookSecret: secret });
  });
}

async function prepareGmailEventConfigForPersist(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly eventType: ZeroWorkflowEventType;
    readonly eventConfig: GmailWorkflowEventConfig;
    readonly signal: AbortSignal;
  },
): Promise<
  | { readonly kind: "ok"; readonly eventConfig: GmailWorkflowEventConfig }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  if (args.eventType === "gmail-new-message") {
    if (args.eventConfig.event !== "new_message") {
      return {
        kind: "bad-request",
        message: "eventConfig must be a Gmail new message config",
      };
    }
    return { kind: "ok", eventConfig: args.eventConfig };
  }

  if (args.eventConfig.event !== "label_applied") {
    return {
      kind: "bad-request",
      message: "eventConfig must be a Gmail label applied config",
    };
  }

  const label = await resolveGmailLabelForUser({
    db,
    orgId: args.orgId,
    userId: args.userId,
    labelName: args.eventConfig.labelName,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (label.kind !== "ok") {
    return { kind: "bad-request", message: label.message };
  }

  return {
    kind: "ok",
    eventConfig: {
      ...args.eventConfig,
      labelName: label.labelName,
      resolvedLabelId: label.labelId,
    },
  };
}

async function insertScheduleTrigger(
  db: Db,
  args: {
    readonly input: CreateScheduleTriggerInput;
    readonly workflowId: string;
    readonly agentId: string;
    readonly workflowTitle: string;
    readonly columns: ScheduleColumns;
    readonly nextRunAt: Date | null;
    readonly currentTime: Date;
  },
): Promise<ZeroWorkflowTriggerSummary> {
  return await db.transaction(async (tx) => {
    const chatThreadId = await ensureWorkflowUserTriggerThread(tx, {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      workflowId: args.workflowId,
      agentId: args.agentId,
      workflowTitle: args.workflowTitle,
      currentTime: args.currentTime,
    });

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
        nextRunAt: args.nextRunAt,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to create workflow trigger");
    }
    return await rowToSummary(tx, row, { chatThreadId });
  });
}

const createEventTriggerForWorkflow$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly input: CreateEventTriggerInput;
      readonly workflowId: string;
      readonly agentId: string;
      readonly workflowTitle: string;
    },
    signal: AbortSignal,
  ): Promise<TriggerResult> => {
    const { input } = args;
    if (input.eventType === "webhook-received") {
      const featureEnabled = await get(
        workflowWebhookTriggersEnabledForOwner(
          input.orgId,
          input.member.userId,
        ),
      );
      signal.throwIfAborted();
      if (!featureEnabled) {
        return {
          kind: "bad-request",
          message: "Workflow webhook triggers are not enabled",
        };
      }

      const summary = await insertWebhookEventTrigger(args.db, {
        input,
        workflowId: args.workflowId,
        agentId: args.agentId,
        workflowTitle: args.workflowTitle,
        currentTime: nowDate(),
      });
      signal.throwIfAborted();
      return { kind: "ok", summary };
    }

    if (input.eventType === "github-label-applied") {
      const featureEnabled = await get(
        workflowGithubLabelEventTriggersEnabledForOwner(
          input.orgId,
          input.member.userId,
        ),
      );
      signal.throwIfAborted();
      if (!featureEnabled) {
        return {
          kind: "bad-request",
          message: "GitHub label workflow event triggers are not enabled",
        };
      }

      const preparedConfig = await prepareGithubLabelEventConfigForPersist(
        args.db,
        {
          orgId: input.orgId,
          userId: input.member.userId,
          eventConfig: input.eventConfig,
        },
      );
      signal.throwIfAborted();
      if (preparedConfig.kind !== "ok") {
        return preparedConfig;
      }

      const summary = await insertWorkflowEventTrigger(args.db, {
        input: { ...input, eventConfig: preparedConfig.eventConfig },
        workflowId: args.workflowId,
        agentId: args.agentId,
        workflowTitle: args.workflowTitle,
        currentTime: nowDate(),
      });
      signal.throwIfAborted();
      return { kind: "ok", summary };
    }

    const featureEnabled = await get(
      gmailWorkflowEventTriggersEnabledForOwner(
        input.orgId,
        input.member.userId,
      ),
    );
    signal.throwIfAborted();
    if (!featureEnabled) {
      return {
        kind: "bad-request",
        message: "Gmail workflow event triggers are not enabled",
      };
    }

    const preparedConfig = await prepareGmailEventConfigForPersist(args.db, {
      orgId: input.orgId,
      userId: input.member.userId,
      eventType: input.eventType,
      eventConfig: input.eventConfig,
      signal,
    });
    signal.throwIfAborted();
    if (preparedConfig.kind !== "ok") {
      return preparedConfig;
    }

    const watchResult = await ensureGmailWatchForUser({
      db: args.db,
      orgId: input.orgId,
      userId: input.member.userId,
      signal,
    });
    signal.throwIfAborted();
    if (watchResult.kind !== "ok") {
      return { kind: "bad-request", message: watchResult.message };
    }

    const summary = await insertWorkflowEventTrigger(args.db, {
      input: { ...input, eventConfig: preparedConfig.eventConfig },
      workflowId: args.workflowId,
      agentId: args.agentId,
      workflowTitle: args.workflowTitle,
      currentTime: nowDate(),
    });
    signal.throwIfAborted();
    return { kind: "ok", summary };
  },
);

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
    const workflowTitle = workflow.displayName ?? workflow.name;

    if (!triggerCreateInputIsSchedule(args)) {
      return await set(
        createEventTriggerForWorkflow$,
        {
          db: writeDb,
          input: args,
          workflowId: workflow.id,
          agentId: agent.id,
          workflowTitle,
        },
        signal,
      );
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
      workflowTitle,
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
): Promise<OwnedTrigger | TriggerActionFailure> {
  const trigger = await loadTriggerRow(db, {
    orgId: args.orgId,
    triggerId: args.triggerId,
  });
  if (!trigger) {
    return { kind: "not-found" };
  }
  if (
    trigger.kind === "event" &&
    !supportedWorkflowEventType(trigger.eventType)
  ) {
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
  readonly eventConfig?: GmailWorkflowEventConfig | GithubWorkflowEventConfig;
}

async function updateTriggerEventConfig(
  db: Db,
  args: {
    readonly triggerId: string;
    readonly eventConfig: GmailWorkflowEventConfig | GithubWorkflowEventConfig;
    readonly signal: AbortSignal;
  },
): Promise<ZeroWorkflowTriggerSummary> {
  const [row] = await db
    .update(zeroWorkflowTriggers)
    .set({
      eventConfig: args.eventConfig,
      updatedAt: nowDate(),
    })
    .where(eq(zeroWorkflowTriggers.id, args.triggerId))
    .returning();
  args.signal.throwIfAborted();
  if (!row) {
    throw new Error("Failed to update workflow trigger");
  }
  return await rowToSummary(db, row);
}

const updateEventTriggerForWorkflow$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly trigger: TriggerRow;
      readonly eventConfig?:
        | GmailWorkflowEventConfig
        | GithubWorkflowEventConfig;
    },
    signal: AbortSignal,
  ): Promise<TriggerResult> => {
    if (args.trigger.eventType === "webhook-received") {
      return {
        kind: "bad-request",
        message: "Webhook event triggers cannot be updated",
      };
    }
    if (args.eventConfig === undefined) {
      return {
        kind: "bad-request",
        message: "eventConfig is required for event triggers",
      };
    }
    if (supportedGithubEventType(args.trigger.eventType)) {
      const parsedConfig = githubLabelAppliedEventConfigSchema.safeParse(
        args.eventConfig,
      );
      if (!parsedConfig.success) {
        return {
          kind: "bad-request",
          message: "eventConfig must be a GitHub label applied config",
        };
      }
      const featureEnabled = await get(
        workflowGithubLabelEventTriggersEnabledForOwner(
          args.orgId,
          args.member.userId,
        ),
      );
      signal.throwIfAborted();
      if (!featureEnabled) {
        return {
          kind: "bad-request",
          message: "GitHub label workflow event triggers are not enabled",
        };
      }
      const preparedConfig = await prepareGithubLabelEventConfigForPersist(
        args.db,
        {
          orgId: args.orgId,
          userId: args.member.userId,
          eventConfig: parsedConfig.data,
        },
      );
      signal.throwIfAborted();
      if (preparedConfig.kind !== "ok") {
        return preparedConfig;
      }
      return {
        kind: "ok",
        summary: await updateTriggerEventConfig(args.db, {
          triggerId: args.trigger.id,
          eventConfig: preparedConfig.eventConfig,
          signal,
        }),
      };
    }
    if (!supportedGmailEventType(args.trigger.eventType)) {
      return { kind: "not-found" };
    }
    const parsedConfig =
      args.trigger.eventType === "gmail-label-applied"
        ? gmailLabelAppliedEventConfigSchema.safeParse(args.eventConfig)
        : gmailNewMessageEventConfigSchema.safeParse(args.eventConfig);
    if (!parsedConfig.success) {
      return {
        kind: "bad-request",
        message: "eventConfig must be a Gmail event config",
      };
    }
    const preparedConfig = await prepareGmailEventConfigForPersist(args.db, {
      orgId: args.orgId,
      userId: args.member.userId,
      eventType: args.trigger.eventType,
      eventConfig: parsedConfig.data,
      signal,
    });
    signal.throwIfAborted();
    if (preparedConfig.kind !== "ok") {
      return preparedConfig;
    }
    return {
      kind: "ok",
      summary: await updateTriggerEventConfig(args.db, {
        triggerId: args.trigger.id,
        eventConfig: preparedConfig.eventConfig,
        signal,
      }),
    };
  },
);

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
      return await set(
        updateEventTriggerForWorkflow$,
        {
          db: writeDb,
          orgId: args.orgId,
          member: args.member,
          trigger,
          eventConfig: args.eventConfig,
        },
        signal,
      );
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
    const nextRunAt = resolveNextRunAt(
      args.schedule,
      trigger.enabled,
      now,
      trigger.lastRunAt,
    );

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
    return { kind: "ok", summary: await rowToSummary(writeDb, row) };
  },
);

interface TriggerActionInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly triggerId: string;
}

function manualTriggerSource(trigger: TriggerRow) {
  return trigger.kind === "event" ? "workflow-event" : "workflow-schedule";
}

function manualWorkflowTriggerSystemPrompt(workflowName: string): string {
  return [
    "# Current context",
    `You are running a manual Trigger now run for the "${workflowName}" workflow.`,
    "The workflow's procedure is available as a skill - execute it now.",
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
    "Connector permissions use the same agent-run permission settings as chat runs. If a request is denied by a permission, do not retry blindly - run `zero doctor permission-deny` to identify the permission, then tell the user which permission this automation needs.",
  ].join("\n");
}

export const runOwnedWorkflowTriggerNow$ = command(
  async (
    { set },
    args: TriggerActionInput,
    signal: AbortSignal,
  ): Promise<WorkflowTriggerRunNowResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedTrigger(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const { trigger } = owned;

    const target = await loadTriggerWorkflowRunTarget(writeDb, {
      orgId: args.orgId,
      workflowId: trigger.workflowId,
    });
    signal.throwIfAborted();
    if (!target) {
      return { kind: "not-found" };
    }
    const agent = await loadAgent(writeDb, {
      orgId: args.orgId,
      agentId: target.agentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      return {
        kind: "conflict",
        message: "Cannot run: the workflow's agent no longer exists.",
      };
    }
    if (!canUseAgent(agent, args.member)) {
      return {
        kind: "forbidden",
        message: "You do not have access to the workflow's agent",
      };
    }

    const currentTime = nowDate();
    const chatThreadId = await writeDb.transaction(async (tx) => {
      return await ensureWorkflowUserTriggerThread(tx, {
        orgId: trigger.orgId,
        userId: trigger.ownerUserId,
        workflowId: trigger.workflowId,
        agentId: target.agentId,
        workflowTitle: target.workflowTitle,
        currentTime,
      });
    });
    signal.throwIfAborted();

    const result = await set(
      runWorkflowTriggerNow$,
      {
        due: {
          trigger,
          agentId: target.agentId,
          workflowName: target.workflowName,
          chatThreadId,
        },
        apiStartTime: currentTime.getTime(),
        triggerSource: manualTriggerSource(trigger),
        appendSystemPrompt: manualWorkflowTriggerSystemPrompt(
          target.workflowName,
        ),
        callbacks: buildChatOnlyWorkflowTriggerCallbacks(
          chatThreadId,
          target.agentId,
        ),
        recordLastRunAt: true,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind !== "ok") {
      return result;
    }
    return {
      kind: "ok",
      runId: result.runId,
      chatThreadId,
    };
  },
);

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
    const chatThreadId = await loadWorkflowUserTriggerThreadId(writeDb, {
      orgId: owned.trigger.orgId,
      userId: owned.trigger.ownerUserId,
      workflowId: owned.trigger.workflowId,
    });
    signal.throwIfAborted();
    // Delete the trigger row only; the bound chat thread is kept.
    await writeDb
      .delete(zeroWorkflowTriggers)
      .where(eq(zeroWorkflowTriggers.id, owned.trigger.id));
    signal.throwIfAborted();
    await publishThreadBoundWorkflowTriggerChanged(
      args.member.userId,
      chatThreadId,
    );
    signal.throwIfAborted();
    return { kind: "deleted" };
  },
);

const ensureEventTriggerCanBeEnabled$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly trigger: TriggerRow;
    },
    signal: AbortSignal,
  ): Promise<TriggerActionFailure | null> => {
    if (args.trigger.eventType === "gmail-new-message") {
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
        db: args.db,
        orgId: args.orgId,
        userId: args.member.userId,
        signal,
      });
      signal.throwIfAborted();
      if (watchResult.kind !== "ok") {
        return { kind: "bad-request", message: watchResult.message };
      }
      return null;
    }

    if (args.trigger.eventType === "github-label-applied") {
      const featureEnabled = await get(
        workflowGithubLabelEventTriggersEnabledForOwner(
          args.orgId,
          args.member.userId,
        ),
      );
      signal.throwIfAborted();
      if (!featureEnabled) {
        return {
          kind: "bad-request",
          message: "GitHub label workflow event triggers are not enabled",
        };
      }
      const config = githubLabelAppliedEventConfigSchema.parse(
        args.trigger.eventConfig,
      );
      const preparedConfig = await prepareGithubLabelEventConfigForPersist(
        args.db,
        {
          orgId: args.orgId,
          userId: args.member.userId,
          eventConfig: config,
        },
      );
      signal.throwIfAborted();
      return preparedConfig.kind === "ok" ? null : preparedConfig;
    }

    if (args.trigger.eventType === "webhook-received") {
      const featureEnabled = await get(
        workflowWebhookTriggersEnabledForOwner(args.orgId, args.member.userId),
      );
      signal.throwIfAborted();
      if (!featureEnabled) {
        return {
          kind: "bad-request",
          message: "Workflow webhook triggers are not enabled",
        };
      }
    }
    return null;
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
    const nextRunAt =
      trigger.kind === "schedule"
        ? resolveNextRunAt(rowToSchedule(trigger), true, now, trigger.lastRunAt)
        : trigger.nextRunAt;
    if (trigger.kind === "event") {
      const failure = await set(
        ensureEventTriggerCanBeEnabled$,
        {
          db: writeDb,
          orgId: args.orgId,
          member: args.member,
          trigger,
        },
        signal,
      );
      signal.throwIfAborted();
      if (failure) {
        return failure;
      }
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
    const chatThreadId = await loadWorkflowUserTriggerThreadId(writeDb, {
      orgId: row.orgId,
      userId: row.ownerUserId,
      workflowId: row.workflowId,
    });
    signal.throwIfAborted();
    await publishThreadBoundWorkflowTriggerChanged(
      args.member.userId,
      chatThreadId,
    );
    signal.throwIfAborted();
    return {
      kind: "ok",
      summary: await rowToSummary(writeDb, row, { chatThreadId }),
    };
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
    const chatThreadId = await loadWorkflowUserTriggerThreadId(writeDb, {
      orgId: row.orgId,
      userId: row.ownerUserId,
      workflowId: row.workflowId,
    });
    signal.throwIfAborted();
    await publishThreadBoundWorkflowTriggerChanged(
      args.member.userId,
      chatThreadId,
    );
    signal.throwIfAborted();
    return {
      kind: "ok",
      summary: await rowToSummary(writeDb, row, { chatThreadId }),
    };
  },
);
