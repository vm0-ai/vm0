import { command } from "ccstate";
import {
  chatRunFinishedEventConfigSchema,
  gmailLabelAppliedEventConfigSchema,
  gmailNewMessageEventConfigSchema,
  googleCalendarEventCancelledEventConfigSchema,
  googleCalendarEventCreatedEventConfigSchema,
  googleCalendarEventUpdatedEventConfigSchema,
  googleMeetTranscriptGeneratedEventConfigSchema,
  githubDeploymentStatusCreatedEventConfigSchema,
  githubIssueCommentCreatedEventConfigSchema,
  githubLabelAppliedEventConfigSchema,
  githubPullRequestReviewSubmittedEventConfigSchema,
  githubWorkflowJobCompletedEventConfigSchema,
  githubWorkflowRunCompletedEventConfigSchema,
  notionChildPageCreatedEventConfigSchema,
  notionDatabaseItemCreatedEventConfigSchema,
  notionPageContentUpdatedEventConfigSchema,
  strapiEntryPublishedEventConfigSchema,
  webhookReceivedEventConfigSchema,
  type ChatRunFinishedEventConfig,
  type ChatThreadWorkflowAutomation,
  type GmailWorkflowEventConfig,
  type GoogleCalendarWorkflowEventConfig,
  type GoogleMeetWorkflowEventConfig,
  type GithubWorkflowEventConfig,
  type NotionChildPageCreatedEventConfig,
  type NotionChildPageCreatedEventCreateConfig,
  type NotionDatabaseItemCreatedEventConfig,
  type NotionDatabaseItemCreatedEventCreateConfig,
  type NotionPageContentUpdatedEventConfig,
  type NotionPageContentUpdatedEventCreateConfig,
  type NotionWorkflowEventConfig,
  type StrapiEntryPublishedEventConfig,
  type WebhookReceivedEventConfig,
  type ZeroWorkflowEventType,
  type ZeroWorkflowSchedule,
  type ZeroWorkflowWebhookSecretResponse,
  type ZeroWorkflowAutomationsListEntry,
  type ZeroWorkflowAutomationSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { parseScheduledAtTime } from "@vm0/core/timezone";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  strapiIntegrations,
  zeroWorkflowStrapiAutomations,
} from "@vm0/db/schema/strapi-integration";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
  zeroWorkflowWebhookAutomations,
  zeroWorkflows,
  type ZeroWorkflowScheduleType,
} from "@vm0/db/schema/zero-workflow";
import { and, asc, eq } from "drizzle-orm";

import { isZeroMailReplyFollowUpRolloutEnabled } from "../../lib/zero-mail-reply-follow-up-rollout";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { publishChatThreadAutomationsChangedSafely } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { isValidTimeZone, safeSync } from "../utils";
import { calculateNextRun } from "./time-automation";
import {
  loadVisibleWorkflowById,
  visibleWorkflowCondition,
  workflowSummary,
  type WorkflowMember,
} from "./zero-workflow-data.service";
import {
  ensureGmailWatchForUser,
  resolveGmailLabelForUser,
} from "./gmail-workflow-event.service";
import { ensureGoogleCalendarWatchForUser } from "./google-calendar-workflow-event.service";
import { ensureGoogleMeetTranscriptGeneratedSubscriptionForUser } from "./google-meet-workflow-event.service";
import { prepareGithubLabelEventConfigForPersist } from "./github-workflow-event.service";
import { prepareGithubWebhookEventConfigForPersist } from "./github-webhook-automation-event.service";
import { prepareGithubWorkflowRunEventConfigForPersist } from "./github-workflow-run-event.service";
import {
  prepareNotionChildPageEventConfigForPersist,
  prepareNotionDatabaseItemEventConfigForPersist,
  prepareNotionPageContentUpdatedEventConfigForPersist,
} from "./notion-workflow-event.service";
import { notionWorkflowAutomationCreationEnabledForOwner } from "./notion-workflow-automation-feature-switch.service";
import { lockWorkflowWebhookAutomationTierEligibleForOrg } from "./workflow-webhook-automation-entitlement.service";
import {
  buildWorkflowWebhookSummaryFields,
  defaultWebhookReceivedEventConfig,
  encryptWorkflowWebhookSecret,
  encryptWorkflowWebhookToken,
  hashWorkflowWebhookToken,
  mintWorkflowWebhookSecret,
  mintWorkflowWebhookToken,
  revealWorkflowWebhookSecretFields,
} from "./workflow-webhook-automation.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  buildChatOnlyWorkflowAutomationCallbacks,
  runWorkflowAutomationNow$,
  type RunWorkflowAutomationResult,
} from "./zero-workflow-automation-run.service";
import {
  ensureWorkflowUserAutomationThread,
  loadWorkflowUserAutomationThreadId,
} from "./zero-workflow-user-automation-thread.service";
import { buildWorkflowScheduleAutomationBrief } from "./zero-workflow-automation-brief.service";

type AutomationRow = typeof zeroWorkflowAutomations.$inferSelect;
type WorkflowRow = typeof zeroWorkflows.$inferSelect;
type ChatRunFinishedWorkflowEventType = Extract<
  ZeroWorkflowEventType,
  "chat-run-finished"
>;
type GmailWorkflowEventType = Extract<
  ZeroWorkflowEventType,
  "gmail-new-message" | "gmail-label-applied"
>;
type GithubWorkflowEventType = Extract<
  ZeroWorkflowEventType,
  | "github-deployment-status-created"
  | "github-issue-comment-created"
  | "github-label-applied"
  | "github-pull-request-review-submitted"
  | "github-workflow-job-completed"
  | "github-workflow-run-completed"
>;
type GithubWebhookWorkflowEventType = Extract<
  GithubWorkflowEventType,
  | "github-deployment-status-created"
  | "github-issue-comment-created"
  | "github-pull-request-review-submitted"
  | "github-workflow-job-completed"
>;
type GoogleCalendarWorkflowEventType = Extract<
  ZeroWorkflowEventType,
  | "google-calendar-event-created"
  | "google-calendar-event-updated"
  | "google-calendar-event-cancelled"
>;
type GoogleMeetWorkflowEventType = Extract<
  ZeroWorkflowEventType,
  "google-meet-transcript-generated"
>;
type NotionWorkflowEventType = Extract<
  ZeroWorkflowEventType,
  | "notion-child-page-created"
  | "notion-database-item-created"
  | "notion-page-content-updated"
>;
type StrapiWorkflowEventType = Extract<
  ZeroWorkflowEventType,
  "strapi-entry-published"
>;

/**
 * Outcome of an automation mutation, mapped to an HTTP response by the route layer.
 */
export type AutomationResult =
  | { readonly kind: "ok"; readonly summary: ZeroWorkflowAutomationSummary }
  | { readonly kind: "deleted" }
  | { readonly kind: "not-found" }
  | { readonly kind: "forbidden"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "team-required"; readonly message: string }
  | { readonly kind: "bad-request"; readonly message: string };

function workflowWebhookTeamRequiredResult(): {
  readonly kind: "team-required";
  readonly message: string;
} {
  return {
    kind: "team-required",
    message: "Webhook automations require a Team or Custom workspace",
  };
}

function notionWorkflowAutomationsDisabledResult(): {
  readonly kind: "bad-request";
  readonly message: string;
} {
  return {
    kind: "bad-request",
    message: "Notion workflow automations are not enabled",
  };
}

type AutomationActionFailure = Exclude<
  AutomationResult,
  { readonly kind: "ok" } | { readonly kind: "deleted" }
>;
type WorkflowAutomationRunNowResult =
  | {
      readonly kind: "ok";
      readonly runId: string;
      readonly chatThreadId: string;
    }
  | {
      readonly kind: "enqueued";
      readonly chatThreadId: string;
    }
  | AutomationActionFailure
  | Exclude<
      RunWorkflowAutomationResult,
      { readonly kind: "ok" } | { readonly kind: "enqueued" }
    >;

interface CreateEventAutomationWorkflowContext {
  readonly db: Db;
  readonly workflowId: string;
  readonly agentId: string;
  readonly workflowTitle: string;
}

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
 * First/next fire time for a newly created or (re-)enabled automation. A disabled
 * automation is not scheduled. The poller advances cron/loop recurrence after each
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

function requiredScheduleColumn<T>(
  row: AutomationRow,
  field: "cronExpression" | "intervalSeconds" | "atTime",
  value: T | null,
): T {
  if (value === null) {
    throw new Error(
      `Workflow automation ${row.id} has a ${row.scheduleType} schedule without ${field}`,
    );
  }
  return value;
}

function rowToSchedule(row: AutomationRow): ZeroWorkflowSchedule {
  if (row.kind !== "schedule" || row.scheduleType === null) {
    throw new Error(
      `Workflow automation is not a schedule automation: ${row.id}`,
    );
  }
  if (row.scheduleType === "cron") {
    return {
      type: "cron",
      cronExpression: requiredScheduleColumn(
        row,
        "cronExpression",
        row.cronExpression,
      ),
      timezone: row.timezone,
    };
  }
  if (row.scheduleType === "loop") {
    return {
      type: "loop",
      intervalSeconds: requiredScheduleColumn(
        row,
        "intervalSeconds",
        row.intervalSeconds,
      ),
    };
  }
  return {
    type: "once",
    atTime: requiredScheduleColumn(row, "atTime", row.atTime).toISOString(),
    timezone: row.timezone,
  };
}

function supportedWorkflowEventType(
  eventType: string | null,
): eventType is ZeroWorkflowEventType {
  return (
    eventType === "chat-run-finished" ||
    eventType === "gmail-new-message" ||
    eventType === "gmail-label-applied" ||
    eventType === "github-label-applied" ||
    eventType === "github-deployment-status-created" ||
    eventType === "github-issue-comment-created" ||
    eventType === "github-pull-request-review-submitted" ||
    eventType === "github-workflow-job-completed" ||
    eventType === "github-workflow-run-completed" ||
    eventType === "google-calendar-event-created" ||
    eventType === "google-calendar-event-updated" ||
    eventType === "google-calendar-event-cancelled" ||
    eventType === "google-meet-transcript-generated" ||
    eventType === "notion-child-page-created" ||
    eventType === "notion-database-item-created" ||
    eventType === "notion-page-content-updated" ||
    eventType === "strapi-entry-published" ||
    eventType === "webhook-received"
  );
}

function supportedChatRunFinishedEventType(
  eventType: string | null,
): eventType is ChatRunFinishedWorkflowEventType {
  return eventType === "chat-run-finished";
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
  return (
    eventType === "github-label-applied" ||
    eventType === "github-deployment-status-created" ||
    eventType === "github-issue-comment-created" ||
    eventType === "github-pull-request-review-submitted" ||
    eventType === "github-workflow-job-completed" ||
    eventType === "github-workflow-run-completed"
  );
}

function supportedGithubWebhookEventType(
  eventType: string | null,
): eventType is GithubWebhookWorkflowEventType {
  return (
    eventType === "github-deployment-status-created" ||
    eventType === "github-issue-comment-created" ||
    eventType === "github-pull-request-review-submitted" ||
    eventType === "github-workflow-job-completed"
  );
}

function supportedGoogleCalendarEventType(
  eventType: string | null,
): eventType is GoogleCalendarWorkflowEventType {
  return (
    eventType === "google-calendar-event-created" ||
    eventType === "google-calendar-event-updated" ||
    eventType === "google-calendar-event-cancelled"
  );
}

function supportedGoogleMeetEventType(
  eventType: string | null,
): eventType is GoogleMeetWorkflowEventType {
  return eventType === "google-meet-transcript-generated";
}

function supportedNotionEventType(
  eventType: string | null,
): eventType is NotionWorkflowEventType {
  return (
    eventType === "notion-child-page-created" ||
    eventType === "notion-database-item-created" ||
    eventType === "notion-page-content-updated"
  );
}

function supportedStrapiEventType(
  eventType: string | null,
): eventType is StrapiWorkflowEventType {
  return eventType === "strapi-entry-published";
}

function rowSummaryBase(row: AutomationRow, chatThreadId: string | null) {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    enabled: row.enabled,
    chatThreadId,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
  };
}

interface RowToSummaryOptions {
  readonly chatThreadId?: string | null;
  readonly webhookToken?: string;
  readonly webhookSecret?: string;
}

async function resolveAutomationChatThreadId(
  db: ReadonlyDb,
  row: AutomationRow,
  options: RowToSummaryOptions,
): Promise<string | null> {
  if ("chatThreadId" in options) {
    return options.chatThreadId ?? null;
  }
  return await loadWorkflowUserAutomationThreadId(db, {
    orgId: row.orgId,
    userId: row.ownerUserId,
    workflowId: row.workflowId,
  });
}

function notionChildPageRowSummary(
  row: AutomationRow,
  chatThreadId: string | null,
): ZeroWorkflowAutomationSummary {
  return {
    ...rowSummaryBase(row, chatThreadId),
    kind: "event",
    eventType: "notion-child-page-created",
    eventConfig: notionChildPageCreatedEventConfigSchema.parse(row.eventConfig),
    schedule: null,
    scheduleSummary: null,
  };
}

function notionDatabaseItemRowSummary(
  row: AutomationRow,
  chatThreadId: string | null,
): ZeroWorkflowAutomationSummary {
  return {
    ...rowSummaryBase(row, chatThreadId),
    kind: "event",
    eventType: "notion-database-item-created",
    eventConfig: notionDatabaseItemCreatedEventConfigSchema.parse(
      row.eventConfig,
    ),
    schedule: null,
    scheduleSummary: null,
  };
}

function notionPageContentUpdatedRowSummary(
  row: AutomationRow,
  chatThreadId: string | null,
): ZeroWorkflowAutomationSummary {
  return {
    ...rowSummaryBase(row, chatThreadId),
    kind: "event",
    eventType: "notion-page-content-updated",
    eventConfig: notionPageContentUpdatedEventConfigSchema.parse(
      row.eventConfig,
    ),
    schedule: null,
    scheduleSummary: null,
  };
}

function githubEventRowToSummary(
  row: AutomationRow,
  chatThreadId: string | null,
): ZeroWorkflowAutomationSummary | null {
  const summaryBase = {
    ...rowSummaryBase(row, chatThreadId),
    kind: "event" as const,
    schedule: null,
    scheduleSummary: null,
  };
  switch (row.eventType) {
    case "github-label-applied": {
      return {
        ...summaryBase,
        eventType: "github-label-applied",
        eventConfig: githubLabelAppliedEventConfigSchema.parse(row.eventConfig),
      };
    }
    case "github-workflow-run-completed": {
      return {
        ...summaryBase,
        eventType: "github-workflow-run-completed",
        eventConfig: githubWorkflowRunCompletedEventConfigSchema.parse(
          row.eventConfig,
        ),
      };
    }
    case "github-workflow-job-completed": {
      return {
        ...summaryBase,
        eventType: "github-workflow-job-completed",
        eventConfig: githubWorkflowJobCompletedEventConfigSchema.parse(
          row.eventConfig,
        ),
      };
    }
    case "github-pull-request-review-submitted": {
      return {
        ...summaryBase,
        eventType: "github-pull-request-review-submitted",
        eventConfig: githubPullRequestReviewSubmittedEventConfigSchema.parse(
          row.eventConfig,
        ),
      };
    }
    case "github-deployment-status-created": {
      return {
        ...summaryBase,
        eventType: "github-deployment-status-created",
        eventConfig: githubDeploymentStatusCreatedEventConfigSchema.parse(
          row.eventConfig,
        ),
      };
    }
    case "github-issue-comment-created": {
      return {
        ...summaryBase,
        eventType: "github-issue-comment-created",
        eventConfig: githubIssueCommentCreatedEventConfigSchema.parse(
          row.eventConfig,
        ),
      };
    }
    default: {
      return null;
    }
  }
}

function eventRowToSummary(
  row: AutomationRow,
  chatThreadId: string | null,
): ZeroWorkflowAutomationSummary | null {
  if (row.eventType === "chat-run-finished") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "chat-run-finished",
      eventConfig: chatRunFinishedEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.eventType === "gmail-new-message") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: gmailNewMessageEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.eventType === "gmail-label-applied") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: gmailLabelAppliedEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
    };
  }
  const githubSummary = githubEventRowToSummary(row, chatThreadId);
  if (githubSummary) {
    return githubSummary;
  }
  if (row.eventType === "google-calendar-event-created") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "google-calendar-event-created",
      eventConfig: googleCalendarEventCreatedEventConfigSchema.parse(
        row.eventConfig,
      ),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.eventType === "google-calendar-event-updated") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "google-calendar-event-updated",
      eventConfig: googleCalendarEventUpdatedEventConfigSchema.parse(
        row.eventConfig,
      ),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.eventType === "google-calendar-event-cancelled") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "google-calendar-event-cancelled",
      eventConfig: googleCalendarEventCancelledEventConfigSchema.parse(
        row.eventConfig,
      ),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.eventType === "google-meet-transcript-generated") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "google-meet-transcript-generated",
      eventConfig: googleMeetTranscriptGeneratedEventConfigSchema.parse(
        row.eventConfig,
      ),
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (row.eventType === "notion-child-page-created") {
    return notionChildPageRowSummary(row, chatThreadId);
  }
  if (row.eventType === "notion-database-item-created") {
    return notionDatabaseItemRowSummary(row, chatThreadId);
  }
  if (row.eventType === "notion-page-content-updated") {
    return notionPageContentUpdatedRowSummary(row, chatThreadId);
  }
  if (row.eventType === "strapi-entry-published") {
    return {
      ...rowSummaryBase(row, chatThreadId),
      kind: "event",
      eventType: "strapi-entry-published",
      eventConfig: strapiEntryPublishedEventConfigSchema.parse(row.eventConfig),
      schedule: null,
      scheduleSummary: null,
    };
  }
  return null;
}

async function rowToSummary(
  db: ReadonlyDb,
  row: AutomationRow,
  options: RowToSummaryOptions = {},
): Promise<ZeroWorkflowAutomationSummary> {
  const chatThreadId = await resolveAutomationChatThreadId(db, row, options);
  if (row.kind === "event") {
    if (row.eventType === "webhook-received") {
      return {
        ...rowSummaryBase(row, chatThreadId),
        kind: "event",
        eventType: "webhook-received",
        eventConfig: webhookReceivedEventConfigSchema.parse(row.eventConfig),
        schedule: null,
        scheduleSummary: null,
        ...(await buildWorkflowWebhookSummaryFields(db, {
          automation: row,
          webhookToken: options.webhookToken,
          webhookSecret: options.webhookSecret,
        })),
      };
    }
    const eventSummary = eventRowToSummary(row, chatThreadId);
    if (eventSummary) {
      return eventSummary;
    }
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
  row: AutomationRow,
  options: { readonly chatThreadId?: string | null } = {},
): Promise<ZeroWorkflowAutomationSummary | null> {
  if (row.kind === "event" && !supportedWorkflowEventType(row.eventType)) {
    return null;
  }
  if (
    row.eventType === "strapi-entry-published" &&
    !isFeatureEnabled(FeatureSwitchKey.StrapiIntegration, {
      orgId: row.orgId,
    })
  ) {
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
 * An automation run executes as its owner, so the owner must be able to run the
 * workflow's owning agent: public agents are runnable by any member, private
 * agents only by their owner. This is a "use" gate, not the agent "manage" gate.
 */
function canUseAgent(agent: UsableAgent, member: WorkflowMember): boolean {
  return agent.visibility === "public" || agent.owner === member.userId;
}

/**
 * Resolve the workflow's single owning agent for an automation. Under 1:N the agent
 * is derived from `zero_workflows.agent_id`, not from the automation row.
 */
async function loadAutomationWorkflowAgentId(
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

async function loadAutomationWorkflowRunTarget(
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

async function loadAutomationRow(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly automationId: string },
): Promise<AutomationRow | null> {
  const [row] = await db
    .select()
    .from(zeroWorkflowAutomations)
    .where(
      and(
        eq(zeroWorkflowAutomations.orgId, args.orgId),
        eq(zeroWorkflowAutomations.id, args.automationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadAutomationOwnerTimezone(
  db: ReadonlyDb,
  automation: AutomationRow,
): Promise<string | null> {
  const [row] = await db
    .select({ timezone: orgMembersMetadata.timezone })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, automation.orgId),
        eq(orgMembersMetadata.userId, automation.ownerUserId),
      ),
    )
    .limit(1);
  return row?.timezone ?? null;
}

/**
 * List the caller's own workflow automations under a workflow. Detail pages show
 * only the automations the caller owns, so this filters by `ownerUserId`.
 * Visibility of the workflow itself is the caller's responsibility (the workflow
 * must already be resolved as visible).
 */
export async function loadWorkflowAutomations(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly workflowId: string;
    readonly userId: string;
  },
): Promise<readonly ZeroWorkflowAutomationSummary[]> {
  const rows = await db
    .select()
    .from(zeroWorkflowAutomations)
    .where(
      and(
        eq(zeroWorkflowAutomations.orgId, args.orgId),
        eq(zeroWorkflowAutomations.workflowId, args.workflowId),
        eq(zeroWorkflowAutomations.ownerUserId, args.userId),
      ),
    )
    .orderBy(asc(zeroWorkflowAutomations.createdAt));
  const chatThreadId = await loadWorkflowUserAutomationThreadId(db, {
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
 * List the caller's workflow automations across every visible workflow in one
 * lightweight projection. This deliberately avoids workflow detail loading, so
 * it does not read workflow volume files from R2.
 */
export async function listWorkspaceWorkflowAutomations(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
  },
): Promise<readonly ZeroWorkflowAutomationsListEntry[]> {
  const rows = await db
    .select({
      automation: zeroWorkflowAutomations,
      workflow: zeroWorkflows,
      agent: {
        id: zeroAgents.id,
        owner: zeroAgents.owner,
        visibility: zeroAgents.visibility,
        name: zeroAgents.name,
        displayName: zeroAgents.displayName,
      },
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowAutomations.workflowId),
    )
    .innerJoin(zeroAgents, eq(zeroAgents.id, zeroWorkflows.agentId))
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, zeroWorkflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          zeroWorkflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          zeroWorkflowAutomations.workflowId,
        ),
      ),
    )
    .where(
      and(
        eq(zeroWorkflowAutomations.orgId, args.orgId),
        eq(zeroWorkflowAutomations.ownerUserId, args.member.userId),
        visibleWorkflowCondition(args.member),
      ),
    )
    .orderBy(
      asc(zeroWorkflowAutomations.createdAt),
      asc(zeroWorkflowAutomations.id),
    );

  const entries = await Promise.all(
    rows.map(async (row): Promise<ZeroWorkflowAutomationsListEntry | null> => {
      const automation = await rowToPublicSummary(db, row.automation, {
        chatThreadId: row.chatThreadId ?? null,
      });
      if (!automation) {
        return null;
      }
      return {
        workflow: workflowSummary({
          workflow: row.workflow,
          agent: row.agent,
          member: args.member,
        }),
        automation,
      };
    }),
  );
  return entries.flatMap((entry) => {
    return entry ? [entry] : [];
  });
}

function chatThreadAutomationFromSummary(args: {
  readonly workflow: WorkflowRow;
  readonly summary: ZeroWorkflowAutomationSummary | null;
  readonly chatThreadId: string | null;
}): readonly ChatThreadWorkflowAutomation[] {
  const { workflow, summary, chatThreadId } = args;
  if (!summary || chatThreadId === null) {
    return [];
  }
  return [
    {
      ...summary,
      chatThreadId,
      workflow: {
        id: workflow.id,
        agentId: workflow.agentId,
        name: workflow.name,
        displayName: workflow.displayName,
        description: workflow.description,
      },
    },
  ];
}

/**
 * List workflow automations the caller owns that are bound to a chat thread,
 * joined with the workflow identity needed by the chat sidebar.
 */
export async function listThreadBoundWorkflowAutomations(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
): Promise<readonly ChatThreadWorkflowAutomation[]> {
  const rows = await db
    .select({
      automation: zeroWorkflowAutomations,
      workflow: zeroWorkflows,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, zeroWorkflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          zeroWorkflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          zeroWorkflowAutomations.workflowId,
        ),
      ),
    )
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowAutomations.workflowId, zeroWorkflows.id),
    )
    .where(
      and(
        eq(zeroWorkflowAutomations.orgId, args.orgId),
        eq(zeroWorkflowAutomations.ownerUserId, args.userId),
        eq(workflowUserAutomationThreads.chatThreadId, args.threadId),
      ),
    )
    .orderBy(asc(zeroWorkflowAutomations.createdAt));

  const summaries = await Promise.all(
    rows.map(async ({ automation, workflow, chatThreadId }) => {
      const summary = await rowToPublicSummary(db, automation, {
        chatThreadId,
      });
      return { workflow, summary, chatThreadId };
    }),
  );

  return summaries.flatMap((summary) => {
    return chatThreadAutomationFromSummary(summary);
  });
}

/**
 * Load a single automation if its workflow is visible to the caller. Read-only;
 * does not require ownership.
 */
export async function getWorkflowAutomation(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly automationId: string;
  },
): Promise<ZeroWorkflowAutomationSummary | null> {
  const automation = await loadAutomationRow(db, {
    orgId: args.orgId,
    automationId: args.automationId,
  });
  if (!automation) {
    return null;
  }
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: automation.workflowId,
  });
  if (!visible) {
    return null;
  }
  return await rowToPublicSummary(db, automation);
}

export async function revealWorkflowWebhookSecret(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly automationId: string;
  },
): Promise<ZeroWorkflowWebhookSecretResponse | null> {
  const automation = await loadAutomationRow(db, {
    orgId: args.orgId,
    automationId: args.automationId,
  });
  if (
    !automation ||
    automation.kind !== "event" ||
    automation.eventType !== "webhook-received" ||
    automation.ownerUserId !== args.member.userId
  ) {
    return null;
  }
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: automation.workflowId,
  });
  if (!visible) {
    return null;
  }
  return await revealWorkflowWebhookSecretFields(db, { automation });
}

interface CreateScheduleAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly schedule: ZeroWorkflowSchedule;
  readonly enabled: boolean;
}

interface CreateGmailEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: GmailWorkflowEventType;
  readonly eventConfig: GmailWorkflowEventConfig;
  readonly enabled: boolean;
}

interface CreateGithubEventAutomationInputBase {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly enabled: boolean;
}
type CreateGithubEventAutomationInput =
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-label-applied";
      readonly eventConfig: Extract<
        GithubWorkflowEventConfig,
        { readonly event: "label_applied" }
      >;
    })
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-workflow-run-completed";
      readonly eventConfig: Extract<
        GithubWorkflowEventConfig,
        { readonly event: "workflow_run_completed" }
      >;
    })
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-workflow-job-completed";
      readonly eventConfig: Extract<
        GithubWorkflowEventConfig,
        { readonly event: "workflow_job_completed" }
      >;
    })
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-pull-request-review-submitted";
      readonly eventConfig: Extract<
        GithubWorkflowEventConfig,
        { readonly event: "pull_request_review_submitted" }
      >;
    })
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-deployment-status-created";
      readonly eventConfig: Extract<
        GithubWorkflowEventConfig,
        { readonly event: "deployment_status_created" }
      >;
    })
  | (CreateGithubEventAutomationInputBase & {
      readonly eventType: "github-issue-comment-created";
      readonly eventConfig: Extract<
        GithubWorkflowEventConfig,
        { readonly event: "issue_comment_created" }
      >;
    });

interface CreateChatRunFinishedEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: ChatRunFinishedWorkflowEventType;
  readonly eventConfig: ChatRunFinishedEventConfig;
  readonly enabled: boolean;
}

interface CreateGoogleCalendarEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: GoogleCalendarWorkflowEventType;
  readonly eventConfig: GoogleCalendarWorkflowEventConfig;
  readonly enabled: boolean;
}

interface CreateGoogleMeetEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: GoogleMeetWorkflowEventType;
  readonly eventConfig: GoogleMeetWorkflowEventConfig;
  readonly enabled: boolean;
}

interface CreateNotionEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: NotionWorkflowEventType;
  readonly eventConfig:
    | NotionChildPageCreatedEventCreateConfig
    | NotionChildPageCreatedEventConfig
    | NotionDatabaseItemCreatedEventCreateConfig
    | NotionDatabaseItemCreatedEventConfig
    | NotionPageContentUpdatedEventCreateConfig
    | NotionPageContentUpdatedEventConfig;
  readonly enabled: boolean;
}

interface CreateStrapiEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: StrapiWorkflowEventType;
  readonly eventConfig: StrapiEntryPublishedEventConfig;
  readonly enabled: boolean;
}

interface CreateWebhookEventAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly eventType: "webhook-received";
  readonly eventConfig?: WebhookReceivedEventConfig;
  readonly enabled: boolean;
}

type CreateAutomationInput =
  | CreateScheduleAutomationInput
  | CreateChatRunFinishedEventAutomationInput
  | CreateGmailEventAutomationInput
  | CreateGithubEventAutomationInput
  | CreateGoogleCalendarEventAutomationInput
  | CreateGoogleMeetEventAutomationInput
  | CreateNotionEventAutomationInput
  | CreateStrapiEventAutomationInput
  | CreateWebhookEventAutomationInput;
type CreateEventAutomationInput = Exclude<
  CreateAutomationInput,
  CreateScheduleAutomationInput
>;

function automationCreateInputIsSchedule(
  args: CreateAutomationInput,
): args is CreateScheduleAutomationInput {
  return "schedule" in args;
}

function automationCreateInputIsChatRunFinished(
  args: CreateEventAutomationInput,
): args is CreateChatRunFinishedEventAutomationInput {
  return supportedChatRunFinishedEventType(args.eventType);
}

function automationCreateInputIsGmail(
  args: CreateEventAutomationInput,
): args is CreateGmailEventAutomationInput {
  return supportedGmailEventType(args.eventType);
}

function automationCreateInputIsGithubWebhook(
  args: CreateEventAutomationInput,
): args is Extract<
  CreateGithubEventAutomationInput,
  { readonly eventType: GithubWebhookWorkflowEventType }
> {
  return supportedGithubWebhookEventType(args.eventType);
}

function automationCreateInputIsGoogleCalendar(
  args: CreateEventAutomationInput,
): args is CreateGoogleCalendarEventAutomationInput {
  return supportedGoogleCalendarEventType(args.eventType);
}

function automationCreateInputIsGoogleMeet(
  args: CreateEventAutomationInput,
): args is CreateGoogleMeetEventAutomationInput {
  return supportedGoogleMeetEventType(args.eventType);
}

function automationCreateInputIsNotion(
  args: CreateEventAutomationInput,
): args is CreateNotionEventAutomationInput {
  return supportedNotionEventType(args.eventType);
}

function automationCreateInputIsStrapi(
  args: CreateEventAutomationInput,
): args is CreateStrapiEventAutomationInput {
  return supportedStrapiEventType(args.eventType);
}

async function insertWorkflowEventAutomation(
  db: Db,
  args: {
    readonly input:
      | CreateChatRunFinishedEventAutomationInput
      | CreateGmailEventAutomationInput
      | CreateGithubEventAutomationInput
      | CreateGoogleCalendarEventAutomationInput
      | CreateGoogleMeetEventAutomationInput
      | (CreateNotionEventAutomationInput & {
          readonly eventConfig: NotionWorkflowEventConfig;
        });
    readonly workflowId: string;
    readonly agentId: string;
    readonly workflowTitle: string;
    readonly currentTime: Date;
  },
): Promise<ZeroWorkflowAutomationSummary> {
  return await db.transaction(async (tx) => {
    const chatThreadId = await ensureWorkflowUserAutomationThread(tx, {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      workflowId: args.workflowId,
      agentId: args.agentId,
      workflowTitle: args.workflowTitle,
      currentTime: args.currentTime,
    });

    const [row] = await tx
      .insert(zeroWorkflowAutomations)
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
      throw new Error("Failed to create workflow automation");
    }
    return await rowToSummary(tx, row, { chatThreadId });
  });
}

async function insertWebhookEventAutomation(
  db: Db,
  args: {
    readonly input: CreateWebhookEventAutomationInput;
    readonly workflowId: string;
    readonly agentId: string;
    readonly workflowTitle: string;
    readonly currentTime: Date;
    readonly signal: AbortSignal;
  },
): Promise<ZeroWorkflowAutomationSummary | null> {
  return await db.transaction(async (tx) => {
    const tierEligible = await lockWorkflowWebhookAutomationTierEligibleForOrg(
      tx,
      { orgId: args.input.orgId, signal: args.signal },
    );
    if (!tierEligible) {
      return null;
    }

    const chatThreadId = await ensureWorkflowUserAutomationThread(tx, {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      workflowId: args.workflowId,
      agentId: args.agentId,
      workflowTitle: args.workflowTitle,
      currentTime: args.currentTime,
    });

    const [row] = await tx
      .insert(zeroWorkflowAutomations)
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
      throw new Error("Failed to create workflow automation");
    }

    const token = mintWorkflowWebhookToken();
    const secret = mintWorkflowWebhookSecret();
    await tx.insert(zeroWorkflowWebhookAutomations).values({
      automationId: row.id,
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

    return await rowToSummary(tx, row, {
      chatThreadId,
      webhookToken: token,
      webhookSecret: secret,
    });
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
    if (args.eventConfig.threadId && !isZeroMailReplyFollowUpRolloutEnabled()) {
      return {
        kind: "bad-request",
        message: "Gmail thread matching is not enabled",
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

async function insertScheduleAutomation(
  db: Db,
  args: {
    readonly input: CreateScheduleAutomationInput;
    readonly workflowId: string;
    readonly agentId: string;
    readonly workflowTitle: string;
    readonly columns: ScheduleColumns;
    readonly nextRunAt: Date | null;
    readonly currentTime: Date;
  },
): Promise<ZeroWorkflowAutomationSummary> {
  return await db.transaction(async (tx) => {
    const chatThreadId = await ensureWorkflowUserAutomationThread(tx, {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      workflowId: args.workflowId,
      agentId: args.agentId,
      workflowTitle: args.workflowTitle,
      currentTime: args.currentTime,
    });

    const [row] = await tx
      .insert(zeroWorkflowAutomations)
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
      throw new Error("Failed to create workflow automation");
    }
    return await rowToSummary(tx, row, { chatThreadId });
  });
}

async function createWebhookEventAutomationForWorkflow(args: {
  readonly context: CreateEventAutomationWorkflowContext;
  readonly input: CreateWebhookEventAutomationInput;
  readonly signal: AbortSignal;
}): Promise<AutomationResult> {
  const summary = await insertWebhookEventAutomation(args.context.db, {
    input: args.input,
    workflowId: args.context.workflowId,
    agentId: args.context.agentId,
    workflowTitle: args.context.workflowTitle,
    currentTime: nowDate(),
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (!summary) {
    return workflowWebhookTeamRequiredResult();
  }
  return { kind: "ok", summary };
}

async function createGithubLabelEventAutomationForWorkflow(args: {
  readonly context: CreateEventAutomationWorkflowContext;
  readonly input: Extract<
    CreateGithubEventAutomationInput,
    { readonly eventType: "github-label-applied" }
  >;
  readonly signal: AbortSignal;
}): Promise<AutomationResult> {
  const preparedConfig = await prepareGithubLabelEventConfigForPersist(
    args.context.db,
    {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      eventConfig: args.input.eventConfig,
    },
  );
  args.signal.throwIfAborted();
  if (preparedConfig.kind !== "ok") {
    return preparedConfig;
  }

  const summary = await insertWorkflowEventAutomation(args.context.db, {
    input: { ...args.input, eventConfig: preparedConfig.eventConfig },
    workflowId: args.context.workflowId,
    agentId: args.context.agentId,
    workflowTitle: args.context.workflowTitle,
    currentTime: nowDate(),
  });
  args.signal.throwIfAborted();
  return { kind: "ok", summary };
}

async function createGithubWorkflowRunEventAutomationForWorkflow(args: {
  readonly context: CreateEventAutomationWorkflowContext;
  readonly input: Extract<
    CreateGithubEventAutomationInput,
    { readonly eventType: "github-workflow-run-completed" }
  >;
  readonly signal: AbortSignal;
}): Promise<AutomationResult> {
  const preparedConfig = await prepareGithubWorkflowRunEventConfigForPersist(
    args.context.db,
    {
      orgId: args.input.orgId,
      eventConfig: args.input.eventConfig,
    },
  );
  args.signal.throwIfAborted();
  if (preparedConfig.kind !== "ok") {
    return preparedConfig;
  }
  const summary = await insertWorkflowEventAutomation(args.context.db, {
    input: { ...args.input, eventConfig: preparedConfig.eventConfig },
    workflowId: args.context.workflowId,
    agentId: args.context.agentId,
    workflowTitle: args.context.workflowTitle,
    currentTime: nowDate(),
  });
  args.signal.throwIfAborted();
  return { kind: "ok", summary };
}

async function createGithubWebhookEventAutomationForWorkflow(args: {
  readonly context: CreateEventAutomationWorkflowContext;
  readonly input: Extract<
    CreateGithubEventAutomationInput,
    { readonly eventType: GithubWebhookWorkflowEventType }
  >;
  readonly signal: AbortSignal;
}): Promise<AutomationResult> {
  const preparedConfig = await prepareGithubWebhookEventConfigForPersist(
    args.context.db,
    {
      orgId: args.input.orgId,
      eventType: args.input.eventType,
      eventConfig: args.input.eventConfig,
    },
  );
  args.signal.throwIfAborted();
  if (preparedConfig.kind !== "ok") {
    return preparedConfig;
  }
  const summary = await insertWorkflowEventAutomation(args.context.db, {
    input: args.input,
    workflowId: args.context.workflowId,
    agentId: args.context.agentId,
    workflowTitle: args.context.workflowTitle,
    currentTime: nowDate(),
  });
  args.signal.throwIfAborted();
  return { kind: "ok", summary };
}

function parseGoogleCalendarEventConfig(
  eventType: GoogleCalendarWorkflowEventType,
  eventConfig: unknown,
): GoogleCalendarWorkflowEventConfig {
  if (eventType === "google-calendar-event-created") {
    return googleCalendarEventCreatedEventConfigSchema.parse(eventConfig);
  }
  if (eventType === "google-calendar-event-updated") {
    return googleCalendarEventUpdatedEventConfigSchema.parse(eventConfig);
  }
  return googleCalendarEventCancelledEventConfigSchema.parse(eventConfig);
}

async function createGoogleCalendarEventAutomationForWorkflow(args: {
  readonly context: CreateEventAutomationWorkflowContext;
  readonly input: CreateGoogleCalendarEventAutomationInput;
  readonly signal: AbortSignal;
}): Promise<AutomationResult> {
  const preparedConfig = parseGoogleCalendarEventConfig(
    args.input.eventType,
    args.input.eventConfig,
  );
  const watchResult = await ensureGoogleCalendarWatchForUser({
    db: args.context.db,
    orgId: args.input.orgId,
    userId: args.input.member.userId,
    calendarId: preparedConfig.calendarId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (watchResult.kind !== "ok") {
    return { kind: "bad-request", message: watchResult.message };
  }

  const summary = await insertWorkflowEventAutomation(args.context.db, {
    input: { ...args.input, eventConfig: preparedConfig },
    workflowId: args.context.workflowId,
    agentId: args.context.agentId,
    workflowTitle: args.context.workflowTitle,
    currentTime: nowDate(),
  });
  args.signal.throwIfAborted();
  return { kind: "ok", summary };
}

async function createGoogleMeetEventAutomationForWorkflow(args: {
  readonly context: CreateEventAutomationWorkflowContext;
  readonly input: CreateGoogleMeetEventAutomationInput;
  readonly signal: AbortSignal;
}): Promise<AutomationResult> {
  const preparedConfig = googleMeetTranscriptGeneratedEventConfigSchema.parse(
    args.input.eventConfig,
  );
  const subscriptionResult =
    await ensureGoogleMeetTranscriptGeneratedSubscriptionForUser({
      db: args.context.db,
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      signal: args.signal,
    });
  args.signal.throwIfAborted();
  if (subscriptionResult.kind !== "ok") {
    return { kind: "bad-request", message: subscriptionResult.message };
  }

  const summary = await insertWorkflowEventAutomation(args.context.db, {
    input: { ...args.input, eventConfig: preparedConfig },
    workflowId: args.context.workflowId,
    agentId: args.context.agentId,
    workflowTitle: args.context.workflowTitle,
    currentTime: nowDate(),
  });
  args.signal.throwIfAborted();
  return { kind: "ok", summary };
}

async function createNotionEventAutomationForWorkflow(args: {
  readonly context: CreateEventAutomationWorkflowContext;
  readonly input: CreateNotionEventAutomationInput;
  readonly signal: AbortSignal;
}): Promise<AutomationResult> {
  const eventConfig = args.input.eventConfig;
  let preparedConfig:
    | {
        readonly kind: "ok";
        readonly eventConfig: NotionWorkflowEventConfig;
      }
    | { readonly kind: "bad-request"; readonly message: string };
  if (args.input.eventType === "notion-child-page-created") {
    preparedConfig =
      eventConfig.event === "child_page_created"
        ? await prepareNotionChildPageEventConfigForPersist(args.context.db, {
            orgId: args.input.orgId,
            userId: args.input.member.userId,
            eventConfig:
              "parentPageUrl" in eventConfig
                ? eventConfig
                : {
                    provider: "notion",
                    event: "child_page_created",
                    parentPageUrl:
                      eventConfig.parentPage.rawUrl ??
                      eventConfig.parentPage.url,
                  },
            signal: args.signal,
          })
        : {
            kind: "bad-request",
            message: "Unsupported Notion workflow event config",
          };
  } else if (args.input.eventType === "notion-database-item-created") {
    preparedConfig =
      eventConfig.event === "database_item_created"
        ? await prepareNotionDatabaseItemEventConfigForPersist(
            args.context.db,
            {
              orgId: args.input.orgId,
              userId: args.input.member.userId,
              eventConfig:
                "databaseUrl" in eventConfig
                  ? eventConfig
                  : {
                      provider: "notion",
                      event: "database_item_created",
                      databaseUrl:
                        eventConfig.dataSource.rawUrl ??
                        eventConfig.dataSource.url,
                    },
              signal: args.signal,
            },
          )
        : {
            kind: "bad-request",
            message: "Unsupported Notion workflow event config",
          };
  } else {
    preparedConfig =
      eventConfig.event === "page_content_updated"
        ? await prepareNotionPageContentUpdatedEventConfigForPersist(
            args.context.db,
            {
              orgId: args.input.orgId,
              userId: args.input.member.userId,
              eventConfig:
                "scope" in eventConfig
                  ? eventConfig.scope.type === "page"
                    ? {
                        provider: "notion",
                        event: "page_content_updated",
                        pageUrl:
                          eventConfig.scope.page.rawUrl ??
                          eventConfig.scope.page.url,
                      }
                    : {
                        provider: "notion",
                        event: "page_content_updated",
                        databaseUrl:
                          eventConfig.scope.dataSource.rawUrl ??
                          eventConfig.scope.dataSource.url,
                      }
                  : eventConfig,
              signal: args.signal,
            },
          )
        : {
            kind: "bad-request",
            message: "Unsupported Notion workflow event config",
          };
  }
  args.signal.throwIfAborted();
  if (preparedConfig.kind !== "ok") {
    return preparedConfig;
  }

  const summary = await insertWorkflowEventAutomation(args.context.db, {
    input: { ...args.input, eventConfig: preparedConfig.eventConfig },
    workflowId: args.context.workflowId,
    agentId: args.context.agentId,
    workflowTitle: args.context.workflowTitle,
    currentTime: nowDate(),
  });
  args.signal.throwIfAborted();
  return { kind: "ok", summary };
}

async function createStrapiEventAutomationForWorkflow(args: {
  readonly context: CreateEventAutomationWorkflowContext;
  readonly input: CreateStrapiEventAutomationInput;
  readonly signal: AbortSignal;
}): Promise<AutomationResult> {
  if (
    !isFeatureEnabled(FeatureSwitchKey.StrapiIntegration, {
      orgId: args.input.orgId,
    })
  ) {
    return {
      kind: "bad-request",
      message: "Strapi workflow automations are not enabled",
    };
  }
  const eventConfig = strapiEntryPublishedEventConfigSchema.parse(
    args.input.eventConfig,
  );
  const [integration] = await args.context.db
    .select({ id: strapiIntegrations.id })
    .from(strapiIntegrations)
    .where(
      and(
        eq(strapiIntegrations.id, eventConfig.integrationId),
        eq(strapiIntegrations.orgId, args.input.orgId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!integration) {
    return {
      kind: "bad-request",
      message: "Select a Strapi integration from this organization",
    };
  }

  const currentTime = nowDate();
  const summary = await args.context.db.transaction(async (tx) => {
    const chatThreadId = await ensureWorkflowUserAutomationThread(tx, {
      orgId: args.input.orgId,
      userId: args.input.member.userId,
      workflowId: args.context.workflowId,
      agentId: args.context.agentId,
      workflowTitle: args.context.workflowTitle,
      currentTime,
    });
    const [row] = await tx
      .insert(zeroWorkflowAutomations)
      .values({
        orgId: args.input.orgId,
        workflowId: args.context.workflowId,
        ownerUserId: args.input.member.userId,
        kind: "event",
        eventType: args.input.eventType,
        eventConfig,
        scheduleType: null,
        cronExpression: null,
        intervalSeconds: null,
        atTime: null,
        timezone: "UTC",
        enabled: args.input.enabled,
        nextRunAt: null,
        createdAt: currentTime,
        updatedAt: currentTime,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to create Strapi workflow automation");
    }
    await tx.insert(zeroWorkflowStrapiAutomations).values({
      automationId: row.id,
      integrationId: integration.id,
      createdAt: currentTime,
    });
    return await rowToSummary(tx, row, { chatThreadId });
  });
  args.signal.throwIfAborted();
  return { kind: "ok", summary };
}

async function createChatRunFinishedEventAutomationForWorkflow(args: {
  readonly context: {
    readonly db: Db;
    readonly workflowId: string;
    readonly agentId: string;
    readonly workflowTitle: string;
  };
  readonly input: CreateChatRunFinishedEventAutomationInput;
}): Promise<AutomationResult> {
  // The watched thread must belong to the automation owner: the run's final
  // output is surfaced to the workflow run, so cross-user watching would leak
  // another user's conversation.
  const [thread] = await args.context.db
    .select({ userId: chatThreads.userId })
    .from(chatThreads)
    .where(eq(chatThreads.id, args.input.eventConfig.chatThreadId))
    .limit(1);
  if (!thread || thread.userId !== args.input.member.userId) {
    return {
      kind: "bad-request",
      message: `Chat thread not found: ${args.input.eventConfig.chatThreadId}`,
    };
  }

  const summary = await insertWorkflowEventAutomation(args.context.db, {
    input: args.input,
    workflowId: args.context.workflowId,
    agentId: args.context.agentId,
    workflowTitle: args.context.workflowTitle,
    currentTime: nowDate(),
  });
  return { kind: "ok", summary };
}

const createEventAutomationForWorkflow$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly input: CreateEventAutomationInput;
      readonly workflowId: string;
      readonly agentId: string;
      readonly workflowTitle: string;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const { input } = args;
    if (automationCreateInputIsChatRunFinished(input)) {
      return await createChatRunFinishedEventAutomationForWorkflow({
        context: args,
        input,
      });
    }

    if (input.eventType === "webhook-received") {
      return await createWebhookEventAutomationForWorkflow({
        context: args,
        input,
        signal,
      });
    }

    if (input.eventType === "github-label-applied") {
      return await createGithubLabelEventAutomationForWorkflow({
        context: args,
        input,
        signal,
      });
    }

    if (input.eventType === "github-workflow-run-completed") {
      return await createGithubWorkflowRunEventAutomationForWorkflow({
        context: args,
        input,
        signal,
      });
    }

    if (automationCreateInputIsGithubWebhook(input)) {
      return await createGithubWebhookEventAutomationForWorkflow({
        context: args,
        input,
        signal,
      });
    }

    if (automationCreateInputIsGoogleCalendar(input)) {
      return await createGoogleCalendarEventAutomationForWorkflow({
        context: args,
        input,
        signal,
      });
    }

    if (automationCreateInputIsGoogleMeet(input)) {
      return await createGoogleMeetEventAutomationForWorkflow({
        context: args,
        input,
        signal,
      });
    }

    if (automationCreateInputIsNotion(input)) {
      const featureEnabled = await get(
        notionWorkflowAutomationCreationEnabledForOwner(
          input.orgId,
          input.member.userId,
        ),
      );
      signal.throwIfAborted();
      if (!featureEnabled) {
        return notionWorkflowAutomationsDisabledResult();
      }

      return await createNotionEventAutomationForWorkflow({
        context: args,
        input,
        signal,
      });
    }

    if (automationCreateInputIsStrapi(input)) {
      return await createStrapiEventAutomationForWorkflow({
        context: args,
        input,
        signal,
      });
    }

    if (!automationCreateInputIsGmail(input)) {
      return {
        kind: "bad-request",
        message: "Unsupported workflow event automation type",
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

    const summary = await insertWorkflowEventAutomation(args.db, {
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

export const createWorkflowAutomation$ = command(
  async (
    { set },
    args: CreateAutomationInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
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

    // The owning agent is derived from the workflow row (hard 1:N). The automation
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

    if (!automationCreateInputIsSchedule(args)) {
      const result = await set(
        createEventAutomationForWorkflow$,
        {
          db: writeDb,
          input: args,
          workflowId: workflow.id,
          agentId: agent.id,
          workflowTitle,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result.kind === "ok") {
        await publishThreadBoundWorkflowAutomationChanged(
          result.summary.ownerUserId,
          result.summary.chatThreadId,
        );
        signal.throwIfAborted();
      }
      return result;
    }

    const now = nowDate();
    const scheduleError = validateSchedule(args.schedule, now);
    if (scheduleError) {
      return { kind: "bad-request", message: scheduleError };
    }

    const cols = scheduleToColumns(args.schedule);
    const nextRunAt = resolveNextRunAt(args.schedule, args.enabled, now);

    const summary = await insertScheduleAutomation(writeDb, {
      input: args,
      workflowId: workflow.id,
      agentId: agent.id,
      workflowTitle,
      columns: cols,
      nextRunAt,
      currentTime: now,
    });
    signal.throwIfAborted();
    await publishThreadBoundWorkflowAutomationChanged(
      summary.ownerUserId,
      summary.chatThreadId,
    );
    signal.throwIfAborted();
    return { kind: "ok", summary };
  },
);

interface OwnedAutomation {
  readonly automation: AutomationRow;
}

async function publishThreadBoundWorkflowAutomationChanged(
  userId: string,
  chatThreadId: string | null,
): Promise<void> {
  if (chatThreadId === null) {
    return;
  }
  await publishChatThreadAutomationsChangedSafely(userId, chatThreadId);
}

async function loadOwnedAutomation(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly member: WorkflowMember;
    readonly automationId: string;
  },
): Promise<OwnedAutomation | AutomationActionFailure> {
  const automation = await loadAutomationRow(db, {
    orgId: args.orgId,
    automationId: args.automationId,
  });
  if (!automation) {
    return { kind: "not-found" };
  }
  if (
    automation.kind === "event" &&
    !supportedWorkflowEventType(automation.eventType)
  ) {
    return { kind: "not-found" };
  }
  const visible = await loadVisibleWorkflowById(db, {
    orgId: args.orgId,
    member: args.member,
    workflowId: automation.workflowId,
  });
  if (!visible) {
    return { kind: "not-found" };
  }
  if (automation.ownerUserId !== args.member.userId) {
    return {
      kind: "forbidden",
      message: "Only the automation owner can manage this automation",
    };
  }
  return { automation };
}

interface UpdateAutomationInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly automationId: string;
  readonly schedule?: ZeroWorkflowSchedule;
  readonly eventConfig?: GmailWorkflowEventConfig | GithubWorkflowEventConfig;
}

async function updateAutomationEventConfig(
  db: Db,
  args: {
    readonly automationId: string;
    readonly eventConfig: GmailWorkflowEventConfig | GithubWorkflowEventConfig;
    readonly signal: AbortSignal;
  },
): Promise<ZeroWorkflowAutomationSummary> {
  const [row] = await db
    .update(zeroWorkflowAutomations)
    .set({
      eventConfig: args.eventConfig,
      updatedAt: nowDate(),
    })
    .where(eq(zeroWorkflowAutomations.id, args.automationId))
    .returning();
  args.signal.throwIfAborted();
  if (!row) {
    throw new Error("Failed to update workflow automation");
  }
  return await rowToSummary(db, row);
}

function parseGithubAutomationEventConfig(
  eventType: GithubWorkflowEventType,
  eventConfig: unknown,
): GithubWorkflowEventConfig | null {
  const result =
    eventType === "github-label-applied"
      ? githubLabelAppliedEventConfigSchema.safeParse(eventConfig)
      : eventType === "github-workflow-run-completed"
        ? githubWorkflowRunCompletedEventConfigSchema.safeParse(eventConfig)
        : eventType === "github-workflow-job-completed"
          ? githubWorkflowJobCompletedEventConfigSchema.safeParse(eventConfig)
          : eventType === "github-pull-request-review-submitted"
            ? githubPullRequestReviewSubmittedEventConfigSchema.safeParse(
                eventConfig,
              )
            : eventType === "github-deployment-status-created"
              ? githubDeploymentStatusCreatedEventConfigSchema.safeParse(
                  eventConfig,
                )
              : githubIssueCommentCreatedEventConfigSchema.safeParse(
                  eventConfig,
                );
  return result.success ? result.data : null;
}

async function prepareGithubAutomationEventConfig(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly eventType: GithubWorkflowEventType;
    readonly eventConfig: unknown;
  },
) {
  const parsed = parseGithubAutomationEventConfig(
    args.eventType,
    args.eventConfig,
  );
  if (!parsed) {
    return {
      kind: "bad-request" as const,
      message: "eventConfig must match the GitHub automation type",
    };
  }
  if (args.eventType === "github-label-applied") {
    return await prepareGithubLabelEventConfigForPersist(db, {
      orgId: args.orgId,
      userId: args.userId,
      eventConfig: githubLabelAppliedEventConfigSchema.parse(parsed),
    });
  }
  if (args.eventType === "github-workflow-run-completed") {
    return await prepareGithubWorkflowRunEventConfigForPersist(db, {
      orgId: args.orgId,
      eventConfig: githubWorkflowRunCompletedEventConfigSchema.parse(parsed),
    });
  }

  const eventConfig =
    args.eventType === "github-workflow-job-completed"
      ? githubWorkflowJobCompletedEventConfigSchema.parse(parsed)
      : args.eventType === "github-pull-request-review-submitted"
        ? githubPullRequestReviewSubmittedEventConfigSchema.parse(parsed)
        : args.eventType === "github-deployment-status-created"
          ? githubDeploymentStatusCreatedEventConfigSchema.parse(parsed)
          : githubIssueCommentCreatedEventConfigSchema.parse(parsed);
  return await prepareGithubWebhookEventConfigForPersist(db, {
    orgId: args.orgId,
    eventType: args.eventType,
    eventConfig,
  });
}

const updateEventAutomationForWorkflow$ = command(
  async (
    _,
    args: {
      readonly db: Db;
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly automation: AutomationRow;
      readonly eventConfig?:
        | GmailWorkflowEventConfig
        | GithubWorkflowEventConfig;
    },
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    if (args.automation.eventType === "webhook-received") {
      return {
        kind: "bad-request",
        message: "Webhook event automations cannot be updated",
      };
    }
    if (supportedGoogleCalendarEventType(args.automation.eventType)) {
      return {
        kind: "bad-request",
        message: "Google Calendar event automations cannot be updated",
      };
    }
    if (supportedGoogleMeetEventType(args.automation.eventType)) {
      return {
        kind: "bad-request",
        message: "Google Meet event automations cannot be updated",
      };
    }
    if (args.eventConfig === undefined) {
      return {
        kind: "bad-request",
        message: "eventConfig is required for event automations",
      };
    }
    if (supportedGithubEventType(args.automation.eventType)) {
      const eventConfig = await prepareGithubAutomationEventConfig(args.db, {
        orgId: args.orgId,
        userId: args.member.userId,
        eventType: args.automation.eventType,
        eventConfig: args.eventConfig,
      });
      signal.throwIfAborted();
      if (eventConfig.kind !== "ok") {
        return eventConfig;
      }
      return {
        kind: "ok",
        summary: await updateAutomationEventConfig(args.db, {
          automationId: args.automation.id,
          eventConfig: eventConfig.eventConfig,
          signal,
        }),
      };
    }
    if (!supportedGmailEventType(args.automation.eventType)) {
      return { kind: "not-found" };
    }
    const parsedConfig =
      args.automation.eventType === "gmail-label-applied"
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
      eventType: args.automation.eventType,
      eventConfig: parsedConfig.data,
      signal,
    });
    signal.throwIfAborted();
    if (preparedConfig.kind !== "ok") {
      return preparedConfig;
    }
    return {
      kind: "ok",
      summary: await updateAutomationEventConfig(args.db, {
        automationId: args.automation.id,
        eventConfig: preparedConfig.eventConfig,
        signal,
      }),
    };
  },
);

export const updateWorkflowAutomation$ = command(
  async (
    { set },
    args: UpdateAutomationInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedAutomation(writeDb, {
      orgId: args.orgId,
      member: args.member,
      automationId: args.automationId,
    });
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const { automation } = owned;

    if (automation.kind === "event") {
      return await set(
        updateEventAutomationForWorkflow$,
        {
          db: writeDb,
          orgId: args.orgId,
          member: args.member,
          automation,
          eventConfig: args.eventConfig,
        },
        signal,
      );
    }

    if (args.schedule === undefined) {
      return {
        kind: "bad-request",
        message: "schedule is required for schedule automations",
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
      automation.enabled,
      now,
      automation.lastRunAt,
    );

    const row = await writeDb.transaction(async (tx) => {
      const [updated] = await tx
        .update(zeroWorkflowAutomations)
        .set({
          scheduleType: cols.scheduleType,
          cronExpression: cols.cronExpression,
          intervalSeconds: cols.intervalSeconds,
          atTime: cols.atTime,
          timezone: cols.timezone,
          nextRunAt,
          updatedAt: now,
        })
        .where(eq(zeroWorkflowAutomations.id, automation.id))
        .returning();
      if (!updated) {
        throw new Error("Failed to update workflow automation");
      }
      return updated;
    });
    signal.throwIfAborted();
    return { kind: "ok", summary: await rowToSummary(writeDb, row) };
  },
);

interface AutomationActionInput {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly automationId: string;
}

function manualTriggerSource(automation: AutomationRow) {
  return automation.kind === "event" ? "workflow-event" : "workflow-schedule";
}

function manualWorkflowAutomationSystemPrompt(workflowName: string): string {
  return [
    "# Current context",
    `You are running a manual run for the "${workflowName}" workflow.`,
    "The workflow's procedure is available as a skill - execute it now.",
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
    "Connector permissions use the same agent-run permission settings as chat runs. If a connector request fails, do not retry blindly or assume an HTTP error came from Zero permission policy. Run `zero connector check --url <FAILED_URL> --method <METHOD> [--connector <connector-ref>]`; only when it reports a deny or ask outcome, request access with `zero connector permission-request <connector-ref> --permission <name>` and tell the user which permission this automation needs. The user chooses the grant duration in the confirmation UI. Omit query strings or fragments when they may contain secrets because permission matching does not need them.",
  ].join("\n");
}

export const runOwnedWorkflowAutomationNow$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<WorkflowAutomationRunNowResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedAutomation(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const { automation } = owned;
    if (
      automation.eventType === "strapi-entry-published" &&
      !isFeatureEnabled(FeatureSwitchKey.StrapiIntegration, {
        orgId: automation.orgId,
      })
    ) {
      return {
        kind: "bad-request",
        message: "Strapi workflow automations are not enabled",
      };
    }

    const target = await loadAutomationWorkflowRunTarget(writeDb, {
      orgId: args.orgId,
      workflowId: automation.workflowId,
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
    const ownerTimezone = await loadAutomationOwnerTimezone(
      writeDb,
      automation,
    );
    signal.throwIfAborted();
    const chatThreadId = await writeDb.transaction(async (tx) => {
      return await ensureWorkflowUserAutomationThread(tx, {
        orgId: automation.orgId,
        userId: automation.ownerUserId,
        workflowId: automation.workflowId,
        agentId: target.agentId,
        workflowTitle: target.workflowTitle,
        currentTime,
      });
    });
    signal.throwIfAborted();

    const result = await set(
      runWorkflowAutomationNow$,
      {
        due: {
          automation,
          agentId: target.agentId,
          workflowName: target.workflowName,
          chatThreadId,
        },
        apiStartTime: currentTime.getTime(),
        triggerSource: manualTriggerSource(automation),
        triggerBrief:
          buildWorkflowScheduleAutomationBrief({
            createdAt: currentTime,
            scheduleType: automation.scheduleType,
            cronExpression: automation.cronExpression,
            intervalSeconds: automation.intervalSeconds,
            atTime: automation.atTime,
            automationTimezone: automation.timezone,
            userTimezone: ownerTimezone,
          }) ?? undefined,
        appendSystemPrompt: manualWorkflowAutomationSystemPrompt(
          target.workflowName,
        ),
        callbacks: buildChatOnlyWorkflowAutomationCallbacks(
          chatThreadId,
          target.agentId,
        ),
        recordLastRunAt: true,
        coalescePendingScheduleRun: false,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "enqueued") {
      return { kind: "enqueued", chatThreadId };
    }
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

export const deleteWorkflowAutomation$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedAutomation(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const chatThreadId = await loadWorkflowUserAutomationThreadId(writeDb, {
      orgId: owned.automation.orgId,
      userId: owned.automation.ownerUserId,
      workflowId: owned.automation.workflowId,
    });
    signal.throwIfAborted();
    // Delete the automation row only; the bound chat thread is kept.
    await writeDb
      .delete(zeroWorkflowAutomations)
      .where(eq(zeroWorkflowAutomations.id, owned.automation.id));
    signal.throwIfAborted();
    await publishThreadBoundWorkflowAutomationChanged(
      args.member.userId,
      chatThreadId,
    );
    signal.throwIfAborted();
    return { kind: "deleted" };
  },
);

const ensureEventAutomationCanBeEnabled$ = command(
  async (
    _,
    args: {
      readonly db: Db;
      readonly orgId: string;
      readonly member: WorkflowMember;
      readonly automation: AutomationRow;
    },
    signal: AbortSignal,
  ): Promise<AutomationActionFailure | null> => {
    if (args.automation.eventType === "gmail-new-message") {
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

    if (supportedGithubEventType(args.automation.eventType)) {
      const preparedConfig = await prepareGithubAutomationEventConfig(args.db, {
        orgId: args.orgId,
        userId: args.member.userId,
        eventType: args.automation.eventType,
        eventConfig: args.automation.eventConfig,
      });
      signal.throwIfAborted();
      return preparedConfig.kind === "ok" ? null : preparedConfig;
    }

    if (supportedGoogleCalendarEventType(args.automation.eventType)) {
      const config = parseGoogleCalendarEventConfig(
        args.automation.eventType,
        args.automation.eventConfig,
      );
      const watchResult = await ensureGoogleCalendarWatchForUser({
        db: args.db,
        orgId: args.orgId,
        userId: args.member.userId,
        calendarId: config.calendarId,
        signal,
      });
      signal.throwIfAborted();
      if (watchResult.kind !== "ok") {
        return { kind: "bad-request", message: watchResult.message };
      }
      return null;
    }

    if (supportedGoogleMeetEventType(args.automation.eventType)) {
      const subscriptionResult =
        await ensureGoogleMeetTranscriptGeneratedSubscriptionForUser({
          db: args.db,
          orgId: args.orgId,
          userId: args.member.userId,
          signal,
        });
      signal.throwIfAborted();
      if (subscriptionResult.kind !== "ok") {
        return { kind: "bad-request", message: subscriptionResult.message };
      }
      return null;
    }
    return null;
  },
);

async function persistEnabledWorkflowAutomation(
  db: Db,
  args: {
    readonly automation: AutomationRow;
    readonly orgId: string;
    readonly nextRunAt: Date | null;
    readonly now: Date;
    readonly signal: AbortSignal;
  },
): Promise<
  | { readonly status: "team-required" }
  | { readonly status: "ok"; readonly row: AutomationRow | undefined }
> {
  return await db.transaction(async (tx) => {
    if (
      args.automation.kind === "event" &&
      args.automation.eventType === "webhook-received"
    ) {
      const tierEligible =
        await lockWorkflowWebhookAutomationTierEligibleForOrg(tx, {
          orgId: args.orgId,
          signal: args.signal,
        });
      if (!tierEligible) {
        return { status: "team-required" };
      }
    }

    const [enabledRow] = await tx
      .update(zeroWorkflowAutomations)
      .set({
        enabled: true,
        nextRunAt: args.nextRunAt,
        consecutiveFailures: 0,
        updatedAt: args.now,
      })
      .where(eq(zeroWorkflowAutomations.id, args.automation.id))
      .returning();
    if (
      enabledRow &&
      args.automation.kind === "event" &&
      args.automation.eventType === "webhook-received"
    ) {
      await tx
        .update(zeroWorkflowWebhookAutomations)
        .set({ disabledReason: null, updatedAt: args.now })
        .where(
          eq(zeroWorkflowWebhookAutomations.automationId, args.automation.id),
        );
    }
    return { status: "ok", row: enabledRow };
  });
}

export const enableWorkflowAutomation$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedAutomation(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const { automation } = owned;
    if (
      automation.eventType === "strapi-entry-published" &&
      !isFeatureEnabled(FeatureSwitchKey.StrapiIntegration, {
        orgId: automation.orgId,
      })
    ) {
      return {
        kind: "bad-request",
        message: "Strapi workflow automations are not enabled",
      };
    }

    // The owning agent is derived from the workflow row (hard 1:N); it always
    // exists. Re-confirm the owner can still run it before re-enabling.
    const agentId = await loadAutomationWorkflowAgentId(writeDb, {
      orgId: args.orgId,
      workflowId: automation.workflowId,
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
      automation.kind === "schedule"
        ? resolveNextRunAt(
            rowToSchedule(automation),
            true,
            now,
            automation.lastRunAt,
          )
        : automation.nextRunAt;
    if (automation.kind === "event") {
      const failure = await set(
        ensureEventAutomationCanBeEnabled$,
        {
          db: writeDb,
          orgId: args.orgId,
          member: args.member,
          automation,
        },
        signal,
      );
      signal.throwIfAborted();
      if (failure) {
        return failure;
      }
    }
    const enabled = await persistEnabledWorkflowAutomation(writeDb, {
      automation,
      orgId: args.orgId,
      nextRunAt,
      now,
      signal,
    });
    signal.throwIfAborted();
    if (enabled.status === "team-required") {
      return workflowWebhookTeamRequiredResult();
    }
    const row = enabled.row;
    if (!row) {
      throw new Error("Failed to enable workflow automation");
    }
    const chatThreadId = await loadWorkflowUserAutomationThreadId(writeDb, {
      orgId: row.orgId,
      userId: row.ownerUserId,
      workflowId: row.workflowId,
    });
    signal.throwIfAborted();
    await publishThreadBoundWorkflowAutomationChanged(
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

export const disableWorkflowAutomation$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<AutomationResult> => {
    const writeDb = set(writeDb$);
    const owned = await loadOwnedAutomation(writeDb, args);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const now = nowDate();
    const nextRunAt =
      owned.automation.kind === "schedule" ? null : owned.automation.nextRunAt;
    const [row] = await writeDb
      .update(zeroWorkflowAutomations)
      .set({ enabled: false, nextRunAt, updatedAt: now })
      .where(eq(zeroWorkflowAutomations.id, owned.automation.id))
      .returning();
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Failed to disable workflow automation");
    }
    const chatThreadId = await loadWorkflowUserAutomationThreadId(writeDb, {
      orgId: row.orgId,
      userId: row.ownerUserId,
      workflowId: row.workflowId,
    });
    signal.throwIfAborted();
    await publishThreadBoundWorkflowAutomationChanged(
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
