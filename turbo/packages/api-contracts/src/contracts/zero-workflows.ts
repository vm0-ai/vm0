import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";
import { publicConnectorCatalogIconSchema } from "./zero-connector-catalog";

const c = initContract();

export const zeroWorkflowVisibilitySchema = z.enum(["public", "private"]);
export type ZeroWorkflowVisibility = z.infer<
  typeof zeroWorkflowVisibilitySchema
>;

/**
 * Workflow name (slug) validation regex.
 * Must be lowercase alphanumeric with hyphens, no leading/trailing hyphens.
 * Minimum 2 characters. Slugs are NOT unique — duplicates across and within an
 * agent are allowed; run-time picks a winner by a fixed priority rule.
 */
export const zeroWorkflowNameSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);

/**
 * Reserved file name. `SKILL.md` is synthesized server-side from the workflow's
 * (name, description, instruction); users never author or see it.
 */
export const RESERVED_SKILL_FILE = "SKILL.md";

/**
 * A single attached (supplementary) file. The synthesized SKILL.md is never
 * part of this set — `SKILL.md` is a reserved path and is rejected.
 */
export const workflowFileEntrySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(256)
    .refine(
      (p) => {
        return !p.startsWith("/");
      },
      { message: "Path must be relative" },
    )
    .refine(
      (p) => {
        return !p.includes("..");
      },
      { message: "Path must not contain .." },
    )
    .refine(
      (p) => {
        return p !== RESERVED_SKILL_FILE;
      },
      { message: "SKILL.md is reserved and is generated automatically" },
    ),
  content: z.string(),
});

const WORKFLOW_FILES_MAX_BYTES = 5 * 1024 * 1024;
const WORKFLOW_FILES_MAX_COUNT = 500;

/**
 * Attached files (excluding the synthesized SKILL.md). May be empty.
 */
export const workflowFilesSchema = z
  .array(workflowFileEntrySchema)
  .max(
    WORKFLOW_FILES_MAX_COUNT,
    `Maximum ${WORKFLOW_FILES_MAX_COUNT} files allowed`,
  )
  .refine(
    (files) => {
      const total = files.reduce((sum, f) => {
        return sum + new TextEncoder().encode(f.content).length;
      }, 0);
      return total <= WORKFLOW_FILES_MAX_BYTES;
    },
    { message: "Total file size must not exceed 5MB" },
  );

export const workflowFileMetadataSchema = z.object({
  path: z.string(),
  size: z.number(),
});

export const workflowInstructionSchema = z
  .string()
  .max(WORKFLOW_FILES_MAX_BYTES);

export const zeroWorkflowScheduleTypeSchema = z.enum(["cron", "loop", "once"]);
export type ZeroWorkflowScheduleType = z.infer<
  typeof zeroWorkflowScheduleTypeSchema
>;

export const zeroWorkflowAutomationKindSchema = z.enum(["schedule", "event"]);
export type ZeroWorkflowAutomationKind = z.infer<
  typeof zeroWorkflowAutomationKindSchema
>;

export const zeroWorkflowEventTypeSchema = z.enum([
  "chat-run-finished",
  "gmail-new-message",
  "gmail-label-applied",
  "github-label-applied",
  "github-deployment-status-created",
  "github-issue-comment-created",
  "github-pull-request-review-submitted",
  "github-workflow-job-completed",
  "github-workflow-run-completed",
  "google-calendar-event-created",
  "google-calendar-event-updated",
  "google-calendar-event-cancelled",
  "google-meet-transcript-generated",
  "notion-child-page-created",
  "notion-database-item-created",
  "notion-page-content-updated",
  "strapi-entry-published",
  "webhook-received",
]);
export type ZeroWorkflowEventType = z.infer<typeof zeroWorkflowEventTypeSchema>;

export const chatRunFinishedRunStatusSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
]);
export type ChatRunFinishedRunStatus = z.infer<
  typeof chatRunFinishedRunStatusSchema
>;

/**
 * Fires when a run in the watched chat thread reaches a terminal state.
 *
 * `outputPattern` is a `*`-wildcard expression matched case-insensitively
 * against the run's final assistant text (codex: last agent message;
 * claude code: result). Failed runs without assistant text never match a
 * pattern; error messages are not searched.
 */
export const chatRunFinishedEventConfigSchema = z
  .object({
    provider: z.literal("chat"),
    event: z.literal("run_finished"),
    chatThreadId: z.string().uuid(),
    runStatuses: z.array(chatRunFinishedRunStatusSchema).min(1).optional(),
    outputPattern: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type ChatRunFinishedEventConfig = z.infer<
  typeof chatRunFinishedEventConfigSchema
>;

const gmailTextMatchSchema = z
  .object({
    contains: z.string().min(1).optional(),
    containsAny: z.array(z.string().min(1)).min(1).optional(),
    doesNotContain: z.string().min(1).optional(),
    doesNotContainAny: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine(
    (value) => {
      return (
        value.contains !== undefined ||
        value.containsAny !== undefined ||
        value.doesNotContain !== undefined ||
        value.doesNotContainAny !== undefined
      );
    },
    { message: "At least one text matcher is required" },
  );

export const gmailNewMessageEventConfigSchema = z
  .object({
    provider: z.literal("gmail"),
    event: z.literal("new_message"),
    threadId: z.string().min(1).optional(),
    match: z
      .object({
        from: gmailTextMatchSchema.optional(),
        subject: gmailTextMatchSchema.optional(),
        body: gmailTextMatchSchema.optional(),
        to: gmailTextMatchSchema.optional(),
        cc: gmailTextMatchSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GmailNewMessageEventConfig = z.infer<
  typeof gmailNewMessageEventConfigSchema
>;

export const gmailLabelAppliedEventConfigSchema = z
  .object({
    provider: z.literal("gmail"),
    event: z.literal("label_applied"),
    labelName: z.string().trim().min(1).max(225),
    resolvedLabelId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type GmailLabelAppliedEventConfig = z.infer<
  typeof gmailLabelAppliedEventConfigSchema
>;

export const gmailWorkflowEventConfigSchema = z.discriminatedUnion("event", [
  gmailNewMessageEventConfigSchema,
  gmailLabelAppliedEventConfigSchema,
]);
export type GmailWorkflowEventConfig = z.infer<
  typeof gmailWorkflowEventConfigSchema
>;

export const webhookReceivedEventConfigSchema = z
  .object({
    provider: z.literal("webhook"),
    event: z.literal("received"),
    auth: z
      .object({
        mode: z.literal("hmac-sha256"),
      })
      .strict(),
  })
  .strict();
export type WebhookReceivedEventConfig = z.infer<
  typeof webhookReceivedEventConfigSchema
>;

export const githubLabelAppliedSubjectFilterSchema = z.enum([
  "both",
  "issues",
  "pull_requests",
]);
export type GithubLabelAppliedSubjectFilter = z.infer<
  typeof githubLabelAppliedSubjectFilterSchema
>;

export const githubLabelAppliedActorFilterSchema = z
  .object({
    type: z.enum(["me", "anyone"]),
  })
  .strict();
export type GithubLabelAppliedActorFilter = z.infer<
  typeof githubLabelAppliedActorFilterSchema
>;

export const githubLabelAppliedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("label_applied"),
    labelName: z.string().trim().min(1).max(255),
    filters: z
      .object({
        subject: githubLabelAppliedSubjectFilterSchema.default("both"),
        actor: githubLabelAppliedActorFilterSchema.default({ type: "me" }),
      })
      .strict()
      .default({ subject: "both", actor: { type: "me" } }),
  })
  .strict();
export type GithubLabelAppliedEventConfig = z.infer<
  typeof githubLabelAppliedEventConfigSchema
>;

export const githubWorkflowRunConclusionSchema = z.enum([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);
export type GithubWorkflowRunConclusion = z.infer<
  typeof githubWorkflowRunConclusionSchema
>;

const githubFilterValuesSchema = z
  .array(z.string().trim().min(1).max(255))
  .min(1)
  .max(100);

export const githubWorkflowRunCompletedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("workflow_run_completed"),
    filters: z
      .object({
        repositories: githubFilterValuesSchema.optional(),
        workflows: githubFilterValuesSchema.optional(),
        conclusions: z
          .array(githubWorkflowRunConclusionSchema)
          .min(1)
          .max(githubWorkflowRunConclusionSchema.options.length)
          .optional(),
        branches: githubFilterValuesSchema.optional(),
        events: githubFilterValuesSchema.optional(),
        actors: githubFilterValuesSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type GithubWorkflowRunCompletedEventConfig = z.infer<
  typeof githubWorkflowRunCompletedEventConfigSchema
>;

export const githubWorkflowJobCompletedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("workflow_job_completed"),
    filters: z
      .object({
        repositories: githubFilterValuesSchema.optional(),
        workflows: githubFilterValuesSchema.optional(),
        jobs: githubFilterValuesSchema.optional(),
        conclusions: z
          .array(githubWorkflowRunConclusionSchema)
          .min(1)
          .max(githubWorkflowRunConclusionSchema.options.length)
          .optional(),
        branches: githubFilterValuesSchema.optional(),
        runnerLabels: githubFilterValuesSchema.optional(),
        runnerGroups: githubFilterValuesSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type GithubWorkflowJobCompletedEventConfig = z.infer<
  typeof githubWorkflowJobCompletedEventConfigSchema
>;

export const githubPullRequestReviewStateSchema = z.enum([
  "approved",
  "changes_requested",
  "commented",
]);
export type GithubPullRequestReviewState = z.infer<
  typeof githubPullRequestReviewStateSchema
>;

export const githubPullRequestReviewSubmittedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("pull_request_review_submitted"),
    filters: z
      .object({
        repositories: githubFilterValuesSchema.optional(),
        reviewStates: z
          .array(githubPullRequestReviewStateSchema)
          .min(1)
          .max(githubPullRequestReviewStateSchema.options.length)
          .optional(),
        baseBranches: githubFilterValuesSchema.optional(),
        headBranches: githubFilterValuesSchema.optional(),
        trustedAuthors: githubFilterValuesSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type GithubPullRequestReviewSubmittedEventConfig = z.infer<
  typeof githubPullRequestReviewSubmittedEventConfigSchema
>;

export const githubDeploymentStateSchema = z.enum([
  "error",
  "failure",
  "inactive",
  "in_progress",
  "pending",
  "queued",
  "success",
  "waiting",
]);
export type GithubDeploymentState = z.infer<typeof githubDeploymentStateSchema>;

export const githubDeploymentStatusCreatedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("deployment_status_created"),
    filters: z
      .object({
        repositories: githubFilterValuesSchema.optional(),
        environments: githubFilterValuesSchema.optional(),
        states: z
          .array(githubDeploymentStateSchema)
          .min(1)
          .max(githubDeploymentStateSchema.options.length)
          .optional(),
        refs: githubFilterValuesSchema.optional(),
        productionEnvironment: z.boolean().optional(),
        creators: githubFilterValuesSchema.optional(),
        apps: githubFilterValuesSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type GithubDeploymentStatusCreatedEventConfig = z.infer<
  typeof githubDeploymentStatusCreatedEventConfigSchema
>;

export const githubIssueCommentSubjectFilterSchema = z.enum([
  "both",
  "issues",
  "pull_requests",
]);
export type GithubIssueCommentSubjectFilter = z.infer<
  typeof githubIssueCommentSubjectFilterSchema
>;

export const githubIssueCommentCreatedEventConfigSchema = z
  .object({
    provider: z.literal("github"),
    event: z.literal("issue_comment_created"),
    filters: z
      .object({
        repositories: githubFilterValuesSchema.optional(),
        subject: githubIssueCommentSubjectFilterSchema.default("both"),
        trustedAuthors: githubFilterValuesSchema.optional(),
        commentPrefixes: z
          .array(z.string().trim().min(1).max(1024))
          .min(1)
          .max(100)
          .optional(),
      })
      .strict()
      .default({ subject: "both" }),
  })
  .strict();
export type GithubIssueCommentCreatedEventConfig = z.infer<
  typeof githubIssueCommentCreatedEventConfigSchema
>;

export const githubWorkflowEventConfigSchema = z.discriminatedUnion("event", [
  githubLabelAppliedEventConfigSchema,
  githubDeploymentStatusCreatedEventConfigSchema,
  githubIssueCommentCreatedEventConfigSchema,
  githubPullRequestReviewSubmittedEventConfigSchema,
  githubWorkflowJobCompletedEventConfigSchema,
  githubWorkflowRunCompletedEventConfigSchema,
]);
export type GithubWorkflowEventConfig = z.infer<
  typeof githubWorkflowEventConfigSchema
>;

export const googleCalendarEventCreatedEventConfigSchema = z
  .object({
    provider: z.literal("google-calendar"),
    event: z.literal("event_created"),
    calendarId: z.string().trim().min(1).max(1024).default("primary"),
  })
  .strict();
export type GoogleCalendarEventCreatedEventConfig = z.infer<
  typeof googleCalendarEventCreatedEventConfigSchema
>;

export const googleCalendarEventUpdatedEventConfigSchema = z
  .object({
    provider: z.literal("google-calendar"),
    event: z.literal("event_updated"),
    calendarId: z.string().trim().min(1).max(1024).default("primary"),
  })
  .strict();
export type GoogleCalendarEventUpdatedEventConfig = z.infer<
  typeof googleCalendarEventUpdatedEventConfigSchema
>;

export const googleCalendarEventCancelledEventConfigSchema = z
  .object({
    provider: z.literal("google-calendar"),
    event: z.literal("event_cancelled"),
    calendarId: z.string().trim().min(1).max(1024).default("primary"),
  })
  .strict();
export type GoogleCalendarEventCancelledEventConfig = z.infer<
  typeof googleCalendarEventCancelledEventConfigSchema
>;

export type GoogleCalendarWorkflowEventConfig =
  | GoogleCalendarEventCreatedEventConfig
  | GoogleCalendarEventUpdatedEventConfig
  | GoogleCalendarEventCancelledEventConfig;

export const googleMeetTranscriptGeneratedEventConfigSchema = z
  .object({
    provider: z.literal("google-meet"),
    event: z.literal("transcript_generated"),
    scope: z
      .object({
        type: z.literal("organizer_user"),
      })
      .strict()
      .default({ type: "organizer_user" }),
  })
  .strict();
export type GoogleMeetTranscriptGeneratedEventConfig = z.infer<
  typeof googleMeetTranscriptGeneratedEventConfigSchema
>;
export type GoogleMeetWorkflowEventConfig =
  GoogleMeetTranscriptGeneratedEventConfig;

export const notionPageReferenceSchema = z
  .object({
    id: z.string().uuid(),
    url: z.url(),
    title: z.string().nullable(),
    rawUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type NotionPageReference = z.infer<typeof notionPageReferenceSchema>;

export const notionDataSourceReferenceSchema = z
  .object({
    id: z.string().uuid(),
    url: z.url(),
    title: z.string().nullable(),
    rawUrl: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type NotionDataSourceReference = z.infer<
  typeof notionDataSourceReferenceSchema
>;

export const notionChildPageCreatedEventConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("child_page_created"),
    connectorId: z.string().uuid(),
    parentPage: notionPageReferenceSchema,
  })
  .strict();
export type NotionChildPageCreatedEventConfig = z.infer<
  typeof notionChildPageCreatedEventConfigSchema
>;

export const notionChildPageCreatedEventCreateConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("child_page_created"),
    parentPageUrl: z.string().trim().min(1).max(2048),
  })
  .strict();
export type NotionChildPageCreatedEventCreateConfig = z.infer<
  typeof notionChildPageCreatedEventCreateConfigSchema
>;

export const notionDatabaseItemCreatedEventConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("database_item_created"),
    connectorId: z.string().uuid(),
    dataSource: notionDataSourceReferenceSchema,
  })
  .strict();
export type NotionDatabaseItemCreatedEventConfig = z.infer<
  typeof notionDatabaseItemCreatedEventConfigSchema
>;

export const notionDatabaseItemCreatedEventCreateConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("database_item_created"),
    databaseUrl: z.string().trim().min(1).max(2048),
  })
  .strict();
export type NotionDatabaseItemCreatedEventCreateConfig = z.infer<
  typeof notionDatabaseItemCreatedEventCreateConfigSchema
>;

export const notionPageContentUpdatedScopeSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("page"),
        page: notionPageReferenceSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("data_source"),
        dataSource: notionDataSourceReferenceSchema,
      })
      .strict(),
  ],
);
export type NotionPageContentUpdatedScope = z.infer<
  typeof notionPageContentUpdatedScopeSchema
>;

export const notionPageContentUpdatedEventConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("page_content_updated"),
    connectorId: z.string().uuid(),
    scope: notionPageContentUpdatedScopeSchema,
  })
  .strict();
export type NotionPageContentUpdatedEventConfig = z.infer<
  typeof notionPageContentUpdatedEventConfigSchema
>;

export const notionPageContentUpdatedEventCreateConfigSchema = z
  .object({
    provider: z.literal("notion"),
    event: z.literal("page_content_updated"),
    pageUrl: z.string().trim().min(1).max(2048).optional(),
    databaseUrl: z.string().trim().min(1).max(2048).optional(),
  })
  .strict()
  .refine(
    (value) => {
      return (
        (value.pageUrl !== undefined) !== (value.databaseUrl !== undefined)
      );
    },
    { message: "Provide exactly one of pageUrl or databaseUrl" },
  );
export type NotionPageContentUpdatedEventCreateConfig = z.infer<
  typeof notionPageContentUpdatedEventCreateConfigSchema
>;

export type NotionWorkflowEventConfig =
  | NotionChildPageCreatedEventConfig
  | NotionDatabaseItemCreatedEventConfig
  | NotionPageContentUpdatedEventConfig;

export const strapiEntryPublishedEventConfigSchema = z
  .object({
    provider: z.literal("strapi"),
    event: z.literal("entry_published"),
    integrationId: z.string().uuid(),
    contentTypeUid: z.string().trim().min(1).max(255).optional(),
    locale: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type StrapiEntryPublishedEventConfig = z.infer<
  typeof strapiEntryPublishedEventConfigSchema
>;

/**
 * Schedule configuration, discriminated by `type`. Aligned with Automation's
 * time-based Automation schedule model:
 * - `cron`: recurring at wall-clock times.
 * - `loop`: re-scheduled `intervalSeconds` after each completion.
 * - `once`: fires once at `atTime`, then auto-disables.
 */
export const zeroWorkflowScheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    cronExpression: z.string().min(1).max(100),
    timezone: z.string().min(1),
  }),
  z.object({
    type: z.literal("loop"),
    intervalSeconds: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("once"),
    atTime: z.string().min(1),
    timezone: z.string().min(1),
  }),
]);
export type ZeroWorkflowSchedule = z.infer<typeof zeroWorkflowScheduleSchema>;

/**
 * Automation summary. Under 1:N the agent is derived from the workflow, so
 * automations no longer carry an agentId. Detail responses only ever list the
 * caller's own automations.
 */
const zeroWorkflowAutomationSummaryBaseSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  enabled: z.boolean(),
  chatThreadId: z.string().nullable(),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
});

export const zeroWorkflowScheduleAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("schedule"),
    schedule: zeroWorkflowScheduleSchema,
    scheduleSummary: z.string(),
  });

export const zeroWorkflowChatRunFinishedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("chat-run-finished"),
    eventConfig: chatRunFinishedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGmailNewMessageAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-new-message"),
    eventConfig: gmailNewMessageEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGmailLabelAppliedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-label-applied"),
    eventConfig: gmailLabelAppliedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGithubLabelAppliedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-label-applied"),
    eventConfig: githubLabelAppliedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGithubWorkflowRunCompletedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-run-completed"),
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGithubWorkflowJobCompletedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-job-completed"),
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGithubPullRequestReviewSubmittedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-pull-request-review-submitted"),
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGithubDeploymentStatusCreatedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-deployment-status-created"),
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGithubIssueCommentCreatedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-issue-comment-created"),
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGoogleCalendarEventCreatedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGoogleCalendarEventUpdatedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGoogleCalendarEventCancelledAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGoogleMeetTranscriptGeneratedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-meet-transcript-generated"),
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowNotionChildPageCreatedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-child-page-created"),
    eventConfig: notionChildPageCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowNotionDatabaseItemCreatedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-database-item-created"),
    eventConfig: notionDatabaseItemCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowNotionPageContentUpdatedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-page-content-updated"),
    eventConfig: notionPageContentUpdatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowStrapiEntryPublishedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("strapi-entry-published"),
    eventConfig: strapiEntryPublishedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowWebhookReceivedAutomationSummarySchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("webhook-received"),
    eventConfig: webhookReceivedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
    webhookUrl: z.url().optional(),
    secretLastFour: z.string().length(4),
    disabledReason: z.literal("paid_plan_required").nullable().optional(),
    lastReceivedAt: z.string().datetime().nullable(),
    webhookSecret: z.string().min(1).optional(),
  });

export const zeroWorkflowEventAutomationSummarySchema = z.discriminatedUnion(
  "eventType",
  [
    zeroWorkflowChatRunFinishedAutomationSummarySchema,
    zeroWorkflowGmailNewMessageAutomationSummarySchema,
    zeroWorkflowGmailLabelAppliedAutomationSummarySchema,
    zeroWorkflowGithubLabelAppliedAutomationSummarySchema,
    zeroWorkflowGithubDeploymentStatusCreatedAutomationSummarySchema,
    zeroWorkflowGithubIssueCommentCreatedAutomationSummarySchema,
    zeroWorkflowGithubPullRequestReviewSubmittedAutomationSummarySchema,
    zeroWorkflowGithubWorkflowJobCompletedAutomationSummarySchema,
    zeroWorkflowGithubWorkflowRunCompletedAutomationSummarySchema,
    zeroWorkflowGoogleCalendarEventCreatedAutomationSummarySchema,
    zeroWorkflowGoogleCalendarEventUpdatedAutomationSummarySchema,
    zeroWorkflowGoogleCalendarEventCancelledAutomationSummarySchema,
    zeroWorkflowGoogleMeetTranscriptGeneratedAutomationSummarySchema,
    zeroWorkflowNotionChildPageCreatedAutomationSummarySchema,
    zeroWorkflowNotionDatabaseItemCreatedAutomationSummarySchema,
    zeroWorkflowNotionPageContentUpdatedAutomationSummarySchema,
    zeroWorkflowStrapiEntryPublishedAutomationSummarySchema,
    zeroWorkflowWebhookReceivedAutomationSummarySchema,
  ],
);

export const zeroWorkflowAutomationSummarySchema = z.union([
  zeroWorkflowScheduleAutomationSummarySchema,
  zeroWorkflowEventAutomationSummarySchema,
]);
export type ZeroWorkflowAutomationSummary = z.infer<
  typeof zeroWorkflowAutomationSummarySchema
>;

const chatThreadWorkflowSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  name: zeroWorkflowNameSchema,
  displayName: z.string().nullable(),
  description: z.string().nullable(),
});

const chatThreadWorkflowAutomationBaseSchema =
  zeroWorkflowAutomationSummaryBaseSchema.extend({
    id: z.string().uuid(),
    chatThreadId: z.string().min(1),
    workflow: chatThreadWorkflowSchema,
  });

export const chatThreadWorkflowScheduleAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("schedule"),
    schedule: zeroWorkflowScheduleSchema,
    scheduleSummary: z.string(),
  });

export const chatThreadWorkflowChatRunFinishedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("chat-run-finished"),
    eventConfig: chatRunFinishedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGmailNewMessageAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-new-message"),
    eventConfig: gmailNewMessageEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGmailLabelAppliedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-label-applied"),
    eventConfig: gmailLabelAppliedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubLabelAppliedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-label-applied"),
    eventConfig: githubLabelAppliedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubWorkflowRunCompletedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-run-completed"),
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubWorkflowJobCompletedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-job-completed"),
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubPullRequestReviewSubmittedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-pull-request-review-submitted"),
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubDeploymentStatusCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-deployment-status-created"),
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubIssueCommentCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-issue-comment-created"),
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleCalendarEventCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleCalendarEventUpdatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleCalendarEventCancelledAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleMeetTranscriptGeneratedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-meet-transcript-generated"),
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowNotionChildPageCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-child-page-created"),
    eventConfig: notionChildPageCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowNotionDatabaseItemCreatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-database-item-created"),
    eventConfig: notionDatabaseItemCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowNotionPageContentUpdatedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("notion-page-content-updated"),
    eventConfig: notionPageContentUpdatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowStrapiEntryPublishedAutomationSchema =
  chatThreadWorkflowAutomationBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("strapi-entry-published"),
    eventConfig: strapiEntryPublishedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowWebhookReceivedAutomationSchema =
  zeroWorkflowWebhookReceivedAutomationSummarySchema.extend({
    id: z.string().uuid(),
    chatThreadId: z.string().min(1),
    workflow: chatThreadWorkflowSchema,
  });

export const chatThreadWorkflowAutomationSchema = z.union([
  chatThreadWorkflowScheduleAutomationSchema,
  chatThreadWorkflowChatRunFinishedAutomationSchema,
  chatThreadWorkflowGmailNewMessageAutomationSchema,
  chatThreadWorkflowGmailLabelAppliedAutomationSchema,
  chatThreadWorkflowGithubLabelAppliedAutomationSchema,
  chatThreadWorkflowGithubDeploymentStatusCreatedAutomationSchema,
  chatThreadWorkflowGithubIssueCommentCreatedAutomationSchema,
  chatThreadWorkflowGithubPullRequestReviewSubmittedAutomationSchema,
  chatThreadWorkflowGithubWorkflowJobCompletedAutomationSchema,
  chatThreadWorkflowGithubWorkflowRunCompletedAutomationSchema,
  chatThreadWorkflowGoogleCalendarEventCreatedAutomationSchema,
  chatThreadWorkflowGoogleCalendarEventUpdatedAutomationSchema,
  chatThreadWorkflowGoogleCalendarEventCancelledAutomationSchema,
  chatThreadWorkflowGoogleMeetTranscriptGeneratedAutomationSchema,
  chatThreadWorkflowNotionChildPageCreatedAutomationSchema,
  chatThreadWorkflowNotionDatabaseItemCreatedAutomationSchema,
  chatThreadWorkflowNotionPageContentUpdatedAutomationSchema,
  chatThreadWorkflowStrapiEntryPublishedAutomationSchema,
  chatThreadWorkflowWebhookReceivedAutomationSchema,
]);
export type ChatThreadWorkflowAutomation = z.infer<
  typeof chatThreadWorkflowAutomationSchema
>;

export const zeroWorkflowScheduleAutomationCreateRequestSchema = z.object({
  kind: z.literal("schedule").optional(),
  schedule: zeroWorkflowScheduleSchema,
  enabled: z.boolean().optional(),
});

export const zeroWorkflowChatRunFinishedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("chat-run-finished"),
    eventConfig: chatRunFinishedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGmailNewMessageAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("gmail-new-message"),
    eventConfig: gmailNewMessageEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGmailLabelAppliedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("gmail-label-applied"),
    eventConfig: gmailLabelAppliedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGithubLabelAppliedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-label-applied"),
    eventConfig: githubLabelAppliedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGithubWorkflowRunCompletedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-run-completed"),
    eventConfig: githubWorkflowRunCompletedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGithubWorkflowJobCompletedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-workflow-job-completed"),
    eventConfig: githubWorkflowJobCompletedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGithubPullRequestReviewSubmittedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-pull-request-review-submitted"),
    eventConfig: githubPullRequestReviewSubmittedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGithubDeploymentStatusCreatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-deployment-status-created"),
    eventConfig: githubDeploymentStatusCreatedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGithubIssueCommentCreatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-issue-comment-created"),
    eventConfig: githubIssueCommentCreatedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGoogleCalendarEventCreatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_created",
        calendarId: "primary",
      }),
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGoogleCalendarEventUpdatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_updated",
        calendarId: "primary",
      }),
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGoogleCalendarEventCancelledAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema
      .optional()
      .default({
        provider: "google-calendar",
        event: "event_cancelled",
        calendarId: "primary",
      }),
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGoogleMeetTranscriptGeneratedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("google-meet-transcript-generated"),
    eventConfig: googleMeetTranscriptGeneratedEventConfigSchema
      .optional()
      .default({
        provider: "google-meet",
        event: "transcript_generated",
        scope: { type: "organizer_user" },
      }),
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowNotionChildPageCreatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("notion-child-page-created"),
    eventConfig: notionChildPageCreatedEventCreateConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowNotionDatabaseItemCreatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("notion-database-item-created"),
    eventConfig: notionDatabaseItemCreatedEventCreateConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowNotionPageContentUpdatedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("notion-page-content-updated"),
    eventConfig: notionPageContentUpdatedEventCreateConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowStrapiEntryPublishedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("strapi-entry-published"),
    eventConfig: strapiEntryPublishedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowWebhookReceivedAutomationCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("webhook-received"),
    eventConfig: webhookReceivedEventConfigSchema.optional(),
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowAutomationCreateRequestSchema = z.union([
  zeroWorkflowScheduleAutomationCreateRequestSchema,
  zeroWorkflowChatRunFinishedAutomationCreateRequestSchema,
  zeroWorkflowGmailNewMessageAutomationCreateRequestSchema,
  zeroWorkflowGmailLabelAppliedAutomationCreateRequestSchema,
  zeroWorkflowGithubLabelAppliedAutomationCreateRequestSchema,
  zeroWorkflowGithubDeploymentStatusCreatedAutomationCreateRequestSchema,
  zeroWorkflowGithubIssueCommentCreatedAutomationCreateRequestSchema,
  zeroWorkflowGithubPullRequestReviewSubmittedAutomationCreateRequestSchema,
  zeroWorkflowGithubWorkflowJobCompletedAutomationCreateRequestSchema,
  zeroWorkflowGithubWorkflowRunCompletedAutomationCreateRequestSchema,
  zeroWorkflowGoogleCalendarEventCreatedAutomationCreateRequestSchema,
  zeroWorkflowGoogleCalendarEventUpdatedAutomationCreateRequestSchema,
  zeroWorkflowGoogleCalendarEventCancelledAutomationCreateRequestSchema,
  zeroWorkflowGoogleMeetTranscriptGeneratedAutomationCreateRequestSchema,
  zeroWorkflowNotionChildPageCreatedAutomationCreateRequestSchema,
  zeroWorkflowNotionDatabaseItemCreatedAutomationCreateRequestSchema,
  zeroWorkflowNotionPageContentUpdatedAutomationCreateRequestSchema,
  zeroWorkflowStrapiEntryPublishedAutomationCreateRequestSchema,
  zeroWorkflowWebhookReceivedAutomationCreateRequestSchema,
]);
export type ZeroWorkflowAutomationCreateRequest = z.infer<
  typeof zeroWorkflowAutomationCreateRequestSchema
>;

export const zeroWorkflowScheduleAutomationUpdateRequestSchema = z.object({
  schedule: zeroWorkflowScheduleSchema,
});

export const zeroWorkflowGmailEventAutomationUpdateRequestSchema = z.object({
  eventConfig: gmailWorkflowEventConfigSchema,
});

export const zeroWorkflowGithubEventAutomationUpdateRequestSchema = z.object({
  eventConfig: githubWorkflowEventConfigSchema,
});

export const zeroWorkflowAutomationUpdateRequestSchema = z.union([
  zeroWorkflowScheduleAutomationUpdateRequestSchema,
  zeroWorkflowGmailEventAutomationUpdateRequestSchema,
  zeroWorkflowGithubEventAutomationUpdateRequestSchema,
]);
export type ZeroWorkflowAutomationUpdateRequest = z.infer<
  typeof zeroWorkflowAutomationUpdateRequestSchema
>;

/**
 * Workflow summary. A workflow belongs to exactly one agent (`agentId`).
 * `canManage` reflects the caller's effective rights (agent write-permission
 * for public workflows; ownership for private ones).
 */
export const zeroWorkflowSummarySchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  agentName: z.string().nullable(),
  agentDisplayName: z.string().nullable(),
  name: zeroWorkflowNameSchema,
  displayName: z.string().max(256).nullable(),
  description: z.string().max(1024).nullable(),
  visibility: zeroWorkflowVisibilitySchema,
  ownerUserId: z.string(),
  ownerUserDisplayName: z.string().nullable().optional(),
  ownerUserImageUrl: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  canManage: z.boolean(),
  canPublish: z.boolean(),
  shadowedBy: z
    .object({
      id: z.string().uuid(),
      name: zeroWorkflowNameSchema,
      displayName: z.string().max(256).nullable(),
    })
    .nullable()
    .optional(),
});

export const zeroWorkflowDetailResponseSchema =
  zeroWorkflowSummarySchema.extend({
    createdByUserId: z.string(),
    updatedByUserId: z.string(),
    updatedAt: z.string().datetime(),
    instruction: z.string().nullable(),
    files: z.array(workflowFileMetadataSchema).nullable(),
    fileContents: z.array(workflowFileEntrySchema).nullable(),
    automations: z.array(zeroWorkflowAutomationSummarySchema),
  });

export const zeroWorkflowListResponseSchema = z.array(
  zeroWorkflowSummarySchema,
);

export const zeroWorkflowAutomationsListEntrySchema = z.object({
  workflow: zeroWorkflowSummarySchema,
  automation: zeroWorkflowAutomationSummarySchema,
});
export const zeroWorkflowAutomationsListResponseSchema = z.array(
  zeroWorkflowAutomationsListEntrySchema,
);

export const zeroWorkflowCreateRequestSchema = z.object({
  agentId: z.string().uuid(),
  chatThreadId: z.string().uuid().optional(),
  name: zeroWorkflowNameSchema,
  instruction: workflowInstructionSchema.optional(),
  files: workflowFilesSchema.optional(),
  displayName: z.string().max(256).optional(),
  description: z.string().max(1024).optional(),
  visibility: zeroWorkflowVisibilitySchema.optional(),
});

export const zeroWorkflowUpdateRequestSchema = z
  .object({
    name: zeroWorkflowNameSchema.optional(),
    instruction: workflowInstructionSchema.nullable().optional(),
    files: workflowFilesSchema.optional(),
    displayName: z.string().max(256).nullable().optional(),
    description: z.string().max(1024).nullable().optional(),
  })
  .refine(
    (body) => {
      return (
        body.name !== undefined ||
        body.instruction !== undefined ||
        body.files !== undefined ||
        body.displayName !== undefined ||
        body.description !== undefined
      );
    },
    { message: "At least one workflow update is required" },
  );

export const zeroWorkflowCopyRequestSchema = z.object({
  toAgentId: z.string().uuid(),
});

export const zeroWorkflowRunResponseSchema = z.object({
  chatThreadId: z.string().uuid(),
  // Null means the manual invocation is waiting in the chat thread queue and
  // no run has been created for it yet.
  runId: z.string().nullable(),
});

export const zeroWorkflowChatThreadResponseSchema = z.object({
  chatThreadId: z.string().uuid(),
  prompt: z.string(),
});

export const zeroWorkflowConnectorReadinessStatusSchema = z.enum([
  "connected",
  "not-connected",
  "scope-mismatch",
  "reconnect-required",
  "not-enabled-for-agent",
  "unavailable",
]);
export type ZeroWorkflowConnectorReadinessStatus = z.infer<
  typeof zeroWorkflowConnectorReadinessStatusSchema
>;

export const zeroWorkflowConnectorReadinessEntrySchema = z.object({
  connectorSlug: connectorSlugSchema,
  label: z.string().min(1),
  icon: publicConnectorCatalogIconSchema,
  reason: z.string().min(1),
  status: zeroWorkflowConnectorReadinessStatusSchema,
});
export type ZeroWorkflowConnectorReadinessEntry = z.infer<
  typeof zeroWorkflowConnectorReadinessEntrySchema
>;

export const zeroWorkflowConnectorReadinessResponseSchema = z
  .object({
    connectors: z.array(zeroWorkflowConnectorReadinessEntrySchema),
  })
  .strict();
export type ZeroWorkflowConnectorReadinessResponse = z.infer<
  typeof zeroWorkflowConnectorReadinessResponseSchema
>;

const workflowIdParams = z.object({ workflowId: z.string().uuid() });

export const zeroWorkflowsCollectionContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/workflows",
    headers: authHeadersSchema,
    query: z.object({ agentId: z.string().uuid().optional() }),
    responses: {
      200: zeroWorkflowListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List visible workflows, optionally scoped to one agent",
  },
  create: {
    method: "POST",
    path: "/api/zero/workflows",
    headers: authHeadersSchema,
    body: zeroWorkflowCreateRequestSchema,
    responses: {
      201: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a workflow under an agent",
  },
});

export const zeroWorkflowsDetailContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/workflows/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    responses: {
      200: zeroWorkflowDetailResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a workflow with its instruction and files",
  },
  update: {
    method: "PATCH",
    path: "/api/zero/workflows/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: zeroWorkflowUpdateRequestSchema,
    responses: {
      200: zeroWorkflowDetailResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Update a workflow's instruction, files, or metadata",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/workflows/:workflowId",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a workflow",
  },
  copy: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/copy",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: zeroWorkflowCopyRequestSchema,
    responses: {
      201: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Copy (fork) a workflow onto another agent",
  },
  chatThread: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/chat-thread",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowChatThreadResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get or create the shared chat thread for a workflow",
  },
  run: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/run",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary:
      "Run the workflow once in its shared chat thread (equivalent to /slug)",
  },
  connectorReadiness: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/connector-readiness",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowConnectorReadinessResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Detect the built-in connectors a workflow may need and report their readiness",
  },
});

/** Visibility transitions. */
export const zeroWorkflowVisibilityContract = c.router({
  publish: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/publish",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Publish a private workflow",
  },
  demote: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/demote",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary:
      "Agent write-permission holder demotes a public workflow to private",
  },
});

const automationIdParams = z.object({ id: z.string().uuid() });
const chatThreadIdParams = z.object({ threadId: z.string().min(1) });

export const zeroWorkflowWebhookSecretResponseSchema = z.object({
  webhookUrl: z.url(),
  webhookSecret: z.string().min(1),
});
export type ZeroWorkflowWebhookSecretResponse = z.infer<
  typeof zeroWorkflowWebhookSecretResponseSchema
>;

export const zeroWorkflowAutomationsContract = c.router({
  listWorkspace: {
    method: "GET",
    path: "/api/zero/workflow-automations",
    headers: authHeadersSchema,
    responses: {
      200: zeroWorkflowAutomationsListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List the caller's automations across visible workflows",
  },
  listForChatThread: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/workflow-automations",
    headers: authHeadersSchema,
    pathParams: chatThreadIdParams,
    responses: {
      200: z.array(chatThreadWorkflowAutomationSchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List workflow automations bound to a chat thread",
  },
  list: {
    method: "GET",
    path: "/api/zero/workflows/:workflowId/automations",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    responses: {
      200: z.array(zeroWorkflowAutomationSummarySchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List the caller's own automations for a workflow",
  },
  create: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/automations",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: zeroWorkflowAutomationCreateRequestSchema,
    responses: {
      201: zeroWorkflowAutomationSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create an automation on a workflow",
  },
  get: {
    method: "GET",
    path: "/api/zero/workflow-automations/:id",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    responses: {
      200: zeroWorkflowAutomationSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a workflow automation",
  },
  update: {
    method: "PATCH",
    path: "/api/zero/workflow-automations/:id",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: zeroWorkflowAutomationUpdateRequestSchema,
    responses: {
      200: zeroWorkflowAutomationSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Update a workflow automation",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/workflow-automations/:id",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a workflow automation",
  },
  enable: {
    method: "POST",
    path: "/api/zero/workflow-automations/:id/enable",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowAutomationSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Enable a workflow automation",
  },
  disable: {
    method: "POST",
    path: "/api/zero/workflow-automations/:id/disable",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowAutomationSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disable a workflow automation",
  },
  run: {
    method: "POST",
    path: "/api/zero/workflow-automations/:id/run",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: c.noBody(),
    responses: {
      201: zeroWorkflowRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Submit a workflow automation run in its bound chat thread",
  },
  revealWebhookSecret: {
    method: "POST",
    path: "/api/zero/workflow-automations/:id/webhook-secret",
    headers: authHeadersSchema,
    pathParams: automationIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowWebhookSecretResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Reveal the webhook URL and signing secret for a workflow automation",
  },
});

export type WorkflowFileEntry = z.infer<typeof workflowFileEntrySchema>;
export type WorkflowFileMetadata = z.infer<typeof workflowFileMetadataSchema>;
export type ZeroWorkflowSummary = z.infer<typeof zeroWorkflowSummarySchema>;
export type ZeroWorkflowDetailResponse = z.infer<
  typeof zeroWorkflowDetailResponseSchema
>;
export type ZeroWorkflowCreateRequest = z.infer<
  typeof zeroWorkflowCreateRequestSchema
>;
export type ZeroWorkflowUpdateRequest = z.infer<
  typeof zeroWorkflowUpdateRequestSchema
>;
export type ZeroWorkflowCopyRequest = z.infer<
  typeof zeroWorkflowCopyRequestSchema
>;
export type ZeroWorkflowChatThreadResponse = z.infer<
  typeof zeroWorkflowChatThreadResponseSchema
>;
export type ZeroWorkflowRunResponse = z.infer<
  typeof zeroWorkflowRunResponseSchema
>;
export type ZeroWorkflowAutomationsListEntry = z.infer<
  typeof zeroWorkflowAutomationsListEntrySchema
>;
export type ZeroWorkflowsCollectionContract =
  typeof zeroWorkflowsCollectionContract;
export type ZeroWorkflowsDetailContract = typeof zeroWorkflowsDetailContract;
export type ZeroWorkflowVisibilityContract =
  typeof zeroWorkflowVisibilityContract;
export type ZeroWorkflowAutomationsContract =
  typeof zeroWorkflowAutomationsContract;
