import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

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

export const zeroWorkflowTriggerKindSchema = z.enum(["schedule", "event"]);
export type ZeroWorkflowTriggerKind = z.infer<
  typeof zeroWorkflowTriggerKindSchema
>;

export const zeroWorkflowEventTypeSchema = z.enum([
  "gmail-new-message",
  "gmail-label-applied",
  "github-label-applied",
  "google-calendar-event-created",
  "google-calendar-event-updated",
  "google-calendar-event-cancelled",
  "webhook-received",
]);
export type ZeroWorkflowEventType = z.infer<typeof zeroWorkflowEventTypeSchema>;

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

export type GithubWorkflowEventConfig = GithubLabelAppliedEventConfig;

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

/**
 * Schedule configuration, discriminated by `type`. Aligned with Automation's
 * time-trigger model:
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
 * Trigger summary. Under 1:N the agent is derived from the workflow, so triggers
 * no longer carry an agentId. Detail responses only ever list the caller's own
 * triggers.
 */
const zeroWorkflowTriggerSummaryBaseSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  enabled: z.boolean(),
  chatThreadId: z.string().nullable(),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
});

export const zeroWorkflowScheduleTriggerSummarySchema =
  zeroWorkflowTriggerSummaryBaseSchema.extend({
    kind: z.literal("schedule"),
    schedule: zeroWorkflowScheduleSchema,
    scheduleSummary: z.string(),
  });

export const zeroWorkflowGmailNewMessageTriggerSummarySchema =
  zeroWorkflowTriggerSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-new-message"),
    eventConfig: gmailNewMessageEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGmailLabelAppliedTriggerSummarySchema =
  zeroWorkflowTriggerSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-label-applied"),
    eventConfig: gmailLabelAppliedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGithubLabelAppliedTriggerSummarySchema =
  zeroWorkflowTriggerSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-label-applied"),
    eventConfig: githubLabelAppliedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGoogleCalendarEventCreatedTriggerSummarySchema =
  zeroWorkflowTriggerSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGoogleCalendarEventUpdatedTriggerSummarySchema =
  zeroWorkflowTriggerSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowGoogleCalendarEventCancelledTriggerSummarySchema =
  zeroWorkflowTriggerSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const zeroWorkflowWebhookReceivedTriggerSummarySchema =
  zeroWorkflowTriggerSummaryBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("webhook-received"),
    eventConfig: webhookReceivedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
    webhookUrl: z.url(),
    secretLastFour: z.string().length(4),
    lastReceivedAt: z.string().datetime().nullable(),
    webhookSecret: z.string().min(1).optional(),
  });

export const zeroWorkflowEventTriggerSummarySchema = z.discriminatedUnion(
  "eventType",
  [
    zeroWorkflowGmailNewMessageTriggerSummarySchema,
    zeroWorkflowGmailLabelAppliedTriggerSummarySchema,
    zeroWorkflowGithubLabelAppliedTriggerSummarySchema,
    zeroWorkflowGoogleCalendarEventCreatedTriggerSummarySchema,
    zeroWorkflowGoogleCalendarEventUpdatedTriggerSummarySchema,
    zeroWorkflowGoogleCalendarEventCancelledTriggerSummarySchema,
    zeroWorkflowWebhookReceivedTriggerSummarySchema,
  ],
);

export const zeroWorkflowTriggerSummarySchema = z.union([
  zeroWorkflowScheduleTriggerSummarySchema,
  zeroWorkflowEventTriggerSummarySchema,
]);
export type ZeroWorkflowTriggerSummary = z.infer<
  typeof zeroWorkflowTriggerSummarySchema
>;

const chatThreadWorkflowSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  name: zeroWorkflowNameSchema,
  displayName: z.string().nullable(),
  description: z.string().nullable(),
});

const chatThreadWorkflowTriggerBaseSchema =
  zeroWorkflowTriggerSummaryBaseSchema.extend({
    id: z.string().uuid(),
    chatThreadId: z.string().min(1),
    workflow: chatThreadWorkflowSchema,
  });

export const chatThreadWorkflowScheduleTriggerSchema =
  chatThreadWorkflowTriggerBaseSchema.extend({
    kind: z.literal("schedule"),
    schedule: zeroWorkflowScheduleSchema,
    scheduleSummary: z.string(),
  });

export const chatThreadWorkflowGmailNewMessageTriggerSchema =
  chatThreadWorkflowTriggerBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-new-message"),
    eventConfig: gmailNewMessageEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGmailLabelAppliedTriggerSchema =
  chatThreadWorkflowTriggerBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("gmail-label-applied"),
    eventConfig: gmailLabelAppliedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGithubLabelAppliedTriggerSchema =
  chatThreadWorkflowTriggerBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("github-label-applied"),
    eventConfig: githubLabelAppliedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleCalendarEventCreatedTriggerSchema =
  chatThreadWorkflowTriggerBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-created"),
    eventConfig: googleCalendarEventCreatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleCalendarEventUpdatedTriggerSchema =
  chatThreadWorkflowTriggerBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-updated"),
    eventConfig: googleCalendarEventUpdatedEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowGoogleCalendarEventCancelledTriggerSchema =
  chatThreadWorkflowTriggerBaseSchema.extend({
    kind: z.literal("event"),
    eventType: z.literal("google-calendar-event-cancelled"),
    eventConfig: googleCalendarEventCancelledEventConfigSchema,
    schedule: z.null(),
    scheduleSummary: z.null(),
  });

export const chatThreadWorkflowTriggerSchema = z.union([
  chatThreadWorkflowScheduleTriggerSchema,
  chatThreadWorkflowGmailNewMessageTriggerSchema,
  chatThreadWorkflowGmailLabelAppliedTriggerSchema,
  chatThreadWorkflowGithubLabelAppliedTriggerSchema,
  chatThreadWorkflowGoogleCalendarEventCreatedTriggerSchema,
  chatThreadWorkflowGoogleCalendarEventUpdatedTriggerSchema,
  chatThreadWorkflowGoogleCalendarEventCancelledTriggerSchema,
]);
export type ChatThreadWorkflowTrigger = z.infer<
  typeof chatThreadWorkflowTriggerSchema
>;

export const zeroWorkflowScheduleTriggerCreateRequestSchema = z.object({
  kind: z.literal("schedule").optional(),
  schedule: zeroWorkflowScheduleSchema,
  enabled: z.boolean().optional(),
});

export const zeroWorkflowGmailNewMessageTriggerCreateRequestSchema = z.object({
  kind: z.literal("event"),
  eventType: z.literal("gmail-new-message"),
  eventConfig: gmailNewMessageEventConfigSchema,
  enabled: z.boolean().optional(),
});

export const zeroWorkflowGmailLabelAppliedTriggerCreateRequestSchema = z.object(
  {
    kind: z.literal("event"),
    eventType: z.literal("gmail-label-applied"),
    eventConfig: gmailLabelAppliedEventConfigSchema,
    enabled: z.boolean().optional(),
  },
);

export const zeroWorkflowGithubLabelAppliedTriggerCreateRequestSchema =
  z.object({
    kind: z.literal("event"),
    eventType: z.literal("github-label-applied"),
    eventConfig: githubLabelAppliedEventConfigSchema,
    enabled: z.boolean().optional(),
  });

export const zeroWorkflowGoogleCalendarEventCreatedTriggerCreateRequestSchema =
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

export const zeroWorkflowGoogleCalendarEventUpdatedTriggerCreateRequestSchema =
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

export const zeroWorkflowGoogleCalendarEventCancelledTriggerCreateRequestSchema =
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

export const zeroWorkflowWebhookReceivedTriggerCreateRequestSchema = z.object({
  kind: z.literal("event"),
  eventType: z.literal("webhook-received"),
  eventConfig: webhookReceivedEventConfigSchema.optional(),
  enabled: z.boolean().optional(),
});

export const zeroWorkflowTriggerCreateRequestSchema = z.union([
  zeroWorkflowScheduleTriggerCreateRequestSchema,
  zeroWorkflowGmailNewMessageTriggerCreateRequestSchema,
  zeroWorkflowGmailLabelAppliedTriggerCreateRequestSchema,
  zeroWorkflowGithubLabelAppliedTriggerCreateRequestSchema,
  zeroWorkflowGoogleCalendarEventCreatedTriggerCreateRequestSchema,
  zeroWorkflowGoogleCalendarEventUpdatedTriggerCreateRequestSchema,
  zeroWorkflowGoogleCalendarEventCancelledTriggerCreateRequestSchema,
  zeroWorkflowWebhookReceivedTriggerCreateRequestSchema,
]);
export type ZeroWorkflowTriggerCreateRequest = z.infer<
  typeof zeroWorkflowTriggerCreateRequestSchema
>;

export const zeroWorkflowScheduleTriggerUpdateRequestSchema = z.object({
  schedule: zeroWorkflowScheduleSchema,
});

export const zeroWorkflowGmailEventTriggerUpdateRequestSchema = z.object({
  eventConfig: gmailWorkflowEventConfigSchema,
});

export const zeroWorkflowGithubEventTriggerUpdateRequestSchema = z.object({
  eventConfig: githubLabelAppliedEventConfigSchema,
});

export const zeroWorkflowTriggerUpdateRequestSchema = z.union([
  zeroWorkflowScheduleTriggerUpdateRequestSchema,
  zeroWorkflowGmailEventTriggerUpdateRequestSchema,
  zeroWorkflowGithubEventTriggerUpdateRequestSchema,
]);
export type ZeroWorkflowTriggerUpdateRequest = z.infer<
  typeof zeroWorkflowTriggerUpdateRequestSchema
>;

/**
 * Workflow summary. A workflow belongs to exactly one agent (`agentId`).
 * `requestToPublish` is only meaningful while `visibility = 'private'`.
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
  requestToPublish: z.boolean(),
  ownerUserId: z.string(),
  ownerUserDisplayName: z.string().nullable().optional(),
  ownerUserImageUrl: z.string().nullable().optional(),
  canManage: z.boolean(),
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
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    instruction: z.string().nullable(),
    files: z.array(workflowFileMetadataSchema).nullable(),
    fileContents: z.array(workflowFileEntrySchema).nullable(),
    triggers: z.array(zeroWorkflowTriggerSummarySchema),
  });

export const zeroWorkflowListResponseSchema = z.array(
  zeroWorkflowSummarySchema,
);

export const zeroWorkflowTriggerAutomationEntrySchema = z.object({
  workflow: zeroWorkflowSummarySchema,
  trigger: zeroWorkflowTriggerSummarySchema,
});
export const zeroWorkflowTriggerAutomationListResponseSchema = z.array(
  zeroWorkflowTriggerAutomationEntrySchema,
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
  runId: z.string(),
});

export const zeroWorkflowChatThreadResponseSchema = z.object({
  chatThreadId: z.string().uuid(),
  prompt: z.string(),
});

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
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary:
      "Run the workflow once in its shared chat thread (equivalent to /slug)",
  },
});

/**
 * Visibility transitions. A private workflow whose owner lacks agent
 * write-permission flows through request -> approve/reject; an owner with agent
 * write-permission publishes directly. Demotion is an agent-write operation.
 */
export const zeroWorkflowVisibilityContract = c.router({
  requestPublish: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/request-publish",
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
      "Owner requests promotion to public (auto-approves if owner has agent write-permission)",
  },
  cancelPublishRequest: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/cancel-publish-request",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Owner withdraws a pending publish request",
  },
  approvePublish: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/approve-publish",
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
    summary: "Agent write-permission holder approves a pending publish request",
  },
  rejectPublish: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/reject-publish",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Agent write-permission holder rejects a pending publish request",
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

const triggerIdParams = z.object({ id: z.string().uuid() });
const chatThreadIdParams = z.object({ threadId: z.string().min(1) });

export const zeroWorkflowTriggersContract = c.router({
  listWorkspace: {
    method: "GET",
    path: "/api/zero/workflow-triggers",
    headers: authHeadersSchema,
    responses: {
      200: zeroWorkflowTriggerAutomationListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List the caller's workflow triggers across visible workflows",
  },
  listForChatThread: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/workflow-triggers",
    headers: authHeadersSchema,
    pathParams: chatThreadIdParams,
    responses: {
      200: z.array(chatThreadWorkflowTriggerSchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List workflow triggers bound to a chat thread",
  },
  list: {
    method: "GET",
    path: "/api/zero/workflows/:workflowId/triggers",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    responses: {
      200: z.array(zeroWorkflowTriggerSummarySchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List the caller's own triggers for a workflow",
  },
  create: {
    method: "POST",
    path: "/api/zero/workflows/:workflowId/triggers",
    headers: authHeadersSchema,
    pathParams: workflowIdParams,
    body: zeroWorkflowTriggerCreateRequestSchema,
    responses: {
      201: zeroWorkflowTriggerSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a trigger on a workflow",
  },
  get: {
    method: "GET",
    path: "/api/zero/workflow-triggers/:id",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    responses: {
      200: zeroWorkflowTriggerSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a workflow trigger",
  },
  update: {
    method: "PATCH",
    path: "/api/zero/workflow-triggers/:id",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    body: zeroWorkflowTriggerUpdateRequestSchema,
    responses: {
      200: zeroWorkflowTriggerSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Update a workflow trigger",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/workflow-triggers/:id",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a workflow trigger",
  },
  enable: {
    method: "POST",
    path: "/api/zero/workflow-triggers/:id/enable",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowTriggerSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Enable a workflow trigger",
  },
  disable: {
    method: "POST",
    path: "/api/zero/workflow-triggers/:id/disable",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    body: c.noBody(),
    responses: {
      200: zeroWorkflowTriggerSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disable a workflow trigger",
  },
  run: {
    method: "POST",
    path: "/api/zero/workflow-triggers/:id/run",
    headers: authHeadersSchema,
    pathParams: triggerIdParams,
    body: c.noBody(),
    responses: {
      201: zeroWorkflowRunResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Run a workflow trigger immediately in its bound chat thread",
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
export type ZeroWorkflowTriggerAutomationEntry = z.infer<
  typeof zeroWorkflowTriggerAutomationEntrySchema
>;
export type ZeroWorkflowsCollectionContract =
  typeof zeroWorkflowsCollectionContract;
export type ZeroWorkflowsDetailContract = typeof zeroWorkflowsDetailContract;
export type ZeroWorkflowVisibilityContract =
  typeof zeroWorkflowVisibilityContract;
export type ZeroWorkflowTriggersContract = typeof zeroWorkflowTriggersContract;
