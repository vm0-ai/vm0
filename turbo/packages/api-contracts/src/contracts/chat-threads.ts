import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { CHAT_EVENT_TYPES } from "./chat-events";
import { apiErrorSchema } from "./errors";
import { requireUserMessageForDraftAttachments } from "./draft-user-message";
import { hostedArtifactKindSchema } from "./zero-host";
import { runStatusSchema } from "./runs";
import { zeroGoalEventSchema } from "./zero-goals";
import { triggerSourceSchema } from "./logs";
import { requestedRunModelSchema } from "./model-providers";

const c = initContract();
export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

/**
 * File attachment metadata stored alongside user messages.
 * The `id` is the attachment id — URLs are resolved at query time.
 */
const attachFileSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
});

const assetMaterializationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }),
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("failed"),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    }),
  }),
]);

const assetRefSchema = z.object({
  id: z.string().uuid(),
  classification: z.enum(["input", "published-output"]),
  access: z.enum(["private", "published"]),
  materialization: assetMaterializationSchema,
  provenance: z
    .object({
      provider: z.string(),
    })
    .optional(),
});

/**
 * Attach file returned to the frontend with a resolved URL.
 * Legacy attachments expose a public artifact URL. Canonical input assets use
 * an authenticated same-origin URL and identify their durable asset through
 * `assetRef`.
 */
const resolvedAttachFileSchema = attachFileSchema.extend({
  url: z.string(),
  assetRef: assetRefSchema.optional(),
});

const chatThreadArtifactGoogleDriveSyncSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("synced"),
    id: z.string(),
    name: z.string(),
    webViewLink: z.string().nullable(),
  }),
  z.object({ status: z.literal("not_synced") }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("unknown") }),
]);

const chatThreadArtifactFileSchema = resolvedAttachFileSchema.extend({
  createdAt: z.string(),
  artifactKind: hostedArtifactKindSchema.optional(),
  previewImageUrl: z.string().optional(),
  aliasUrl: z.string().optional(),
  googleDriveSync: chatThreadArtifactGoogleDriveSyncSchema.optional(),
});

const chatThreadArtifactRunSchema = z.object({
  runId: z.string(),
  files: z.array(chatThreadArtifactFileSchema),
});

const artifactItemSchema = z.object({
  artifactItemId: z.string(),
  threadId: z.string(),
  runId: z.string(),
  fileId: z.string(),
  agentId: z.string(),
  agentName: z.string().nullable().optional(),
  agentAvatarUrl: z.string().nullable().optional(),
  threadTitle: z.string().nullable().optional(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().default(0),
  url: z.string(),
  assetRef: assetRefSchema.optional(),
  previewImageUrl: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  artifactKind: hostedArtifactKindSchema.optional(),
  googleDriveSync: chatThreadArtifactGoogleDriveSyncSchema.optional(),
});

/**
 * Keyset pagination for the artifacts list. Both fields are optional so
 * un-paginated callers (older frontend bundles) still get a valid first page.
 * `cursor` is an opaque token returned as `nextCursor` from a previous page.
 */
const artifactsListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(10_000).optional(),
  cursor: z.string().optional(),
  updatedAfter: z.string().datetime().optional(),
});

const artifactsListResponseSchema = z.object({
  artifacts: z.array(artifactItemSchema),
  /**
   * True when more artifacts exist beyond this page. Retained for backward
   * compatibility with older frontend bundles that read it; new clients follow
   * `nextCursor` instead.
   */
  truncated: z.boolean(),
  /**
   * Opaque cursor for the next page, or null when this is the last page.
   */
  nextCursor: z.string().nullable(),
  /**
   * Database time captured before the first page was read. Incremental clients
   * persist it only after the complete page chain has been cached.
   */
  syncUntil: z.string().datetime().optional(),
});

const imageArtifactEditSnapshotItemSchema = z.object({
  url: z.string().url(),
  x: z.number(),
  y: z.number(),
  zIndex: z.number().int(),
});

const imageArtifactEditSnapshotStateSchema = z.object({
  items: z.array(imageArtifactEditSnapshotItemSchema),
  version: z.literal(1),
});

const imageArtifactEditSnapshotQuerySchema = z.object({
  url: z.string().url(),
});

const imageArtifactEditSnapshotUpsertSchema = z.object({
  snapshot: imageArtifactEditSnapshotStateSchema,
  url: z.string().url(),
});

const imageArtifactEditSnapshotSchema = z.object({
  artifactUrl: z.string().url(),
  snapshot: imageArtifactEditSnapshotStateSchema,
  updatedAt: z.string(),
});

/**
 * Attachment metadata persisted in chat_threads.draft_attachments.
 *
 * `url` is the public artifact CDN URL.
 * Historically this stored a 7-day presigned URL that could silently expire
 * while drafts sat in the DB; the public artifact URL removes that footgun.
 */
const persistedAttachmentSchema = z.object({
  id: z.string(),
  url: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
});

/**
 * Per-agent unread snapshot. `unreadAt` is the creation time of the latest
 * run-finish marker — the one that made the thread unread.
 */
const chatThreadUnreadsSchema = z.object({
  unreads: z.array(
    z.object({
      threadId: z.string(),
      unreadAt: z.string(),
    }),
  ),
});

const chatThreadUnreadAgentsSchema = z.object({
  agentIds: z.array(z.string()),
});

const chatThreadEventIdSchema = z.string().uuid();
const codexServiceTierSchema = z.enum(["fast"]);
const chatThreadServiceTierSchema = z.enum(["priority"]);

const chatThreadSnapshotProjectionSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  title: z.string().nullable(),
  sortAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pinnedAt: z.string().nullable(),
  renamedAt: z.string().nullable(),
  selectedModel: z.string().nullable().default(null),
  serviceTier: chatThreadServiceTierSchema.nullable().default(null),
  computerUseHostId: z.string().uuid().nullable().default(null),
  cloudBrowserEnabled: z.boolean().optional(),
});

const chatThreadEventSchema = z.object({
  id: chatThreadEventIdSchema,
  /** Server-assigned strict position within the user/org event stream. */
  seqId: z.number().int().positive(),
  kind: z.enum([
    "created",
    "renamed",
    "deleted",
    "pinned",
    "unpinned",
    "model_selection_updated",
    "service_tier_updated",
    "computer_use_host_updated",
    "sort_touched",
  ]),
  chatThreadId: z.string().uuid(),
  agentId: z.string().uuid(),
  title: z.string().nullable(),
  selectedModel: z.string().nullable().default(null),
  serviceTier: chatThreadServiceTierSchema.nullable().default(null),
  computerUseHostId: z.string().uuid().nullable().default(null),
  cloudBrowserEnabled: z.boolean().optional(),
  createdAt: z.string(),
});

// App promotion is independent from API promotion. Keep response validation
// tolerant of the previous API until every pre-sequence API can no longer
// serve traffic; new API writers still use chatThreadEventSchema above.
const chatThreadEventResponseSchema = chatThreadEventSchema.extend({
  seqId: chatThreadEventSchema.shape.seqId.optional(),
});

const chatEventUsageProviderBreakdownSchema = z.object({
  provider: z.string(),
  credits: z.number().int().nonnegative(),
});

const chatEventUsageKindBreakdownSchema = z.object({
  kind: z.string(),
  credits: z.number().int().nonnegative(),
  providers: z.array(chatEventUsageProviderBreakdownSchema),
});

const chatEventUsagePayloadSchema = z.object({
  version: z.literal(1),
  totalCredits: z.number().int().nonnegative(),
  settledAt: z.string(),
  breakdown: z.array(chatEventUsageKindBreakdownSchema),
});

const toolSummaryEntrySchema = z.object({
  kind: z.literal("tool"),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const textSummaryEntrySchema = z.object({
  kind: z.literal("text"),
  text: z.string(),
});

const summaryEntrySchema = z.union([
  z.string(),
  toolSummaryEntrySchema,
  textSummaryEntrySchema,
]);

const presentationGenerationTemplateRequestSchema = z.object({
  type: z.literal("presentation"),
  selection: z
    .object({
      templateId: z.string().min(1),
      colorSystemId: z.string().min(1).optional(),
      previewUrl: z.string().url().optional(),
    })
    .strict(),
});

const videoGenerationTemplateRequestSchema = z.object({
  type: z.literal("video"),
  selection: z.object({
    stylePresetId: z.string().min(1),
  }),
});

const illustrationGenerationTemplateRequestSchema = z.object({
  type: z.literal("illustration"),
  selection: z.object({
    illustrationStyleId: z.string().min(1),
  }),
});

const workflowGenerationTemplateRequestSchema = z.object({
  type: z.literal("workflow"),
  selection: z.object({
    workflowTemplateId: z.string().min(1),
  }),
});

const websiteGenerationTemplateRequestSchema = z.object({
  type: z.literal("website"),
  selection: z
    .object({
      websiteTemplateId: z.string().min(1),
    })
    .strict(),
});

const generationTemplateRequestSchema = z.discriminatedUnion("type", [
  presentationGenerationTemplateRequestSchema,
  videoGenerationTemplateRequestSchema,
  illustrationGenerationTemplateRequestSchema,
  workflowGenerationTemplateRequestSchema,
  websiteGenerationTemplateRequestSchema,
]);

const userMessageTextPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1),
  })
  .strict();

const userMessageChatThreadPartSchema = z
  .object({
    type: z.literal("chat_thread"),
    threadId: z.string().uuid(),
    titleSnapshot: z.string().min(1),
  })
  .strict();

const userMessageAgentPartSchema = z
  .object({
    type: z.literal("agent"),
    agentId: z.string().uuid(),
    nameSnapshot: z.string().min(1),
  })
  .strict();

const userMessageTemplatePartSchema = z
  .object({
    type: z.literal("template"),
    titleSnapshot: z.string().min(1),
    template: generationTemplateRequestSchema,
  })
  .strict();

const feedbackNotePartSchema = z.discriminatedUnion("type", [
  userMessageTextPartSchema,
  userMessageChatThreadPartSchema,
  userMessageAgentPartSchema,
  userMessageTemplatePartSchema,
]);

const userMessagePartSchema = z.discriminatedUnion("type", [
  userMessageTextPartSchema,
  userMessageChatThreadPartSchema,
  userMessageAgentPartSchema,
  userMessageTemplatePartSchema,
  z
    .object({
      type: z.literal("file"),
      fileId: z.string().min(1),
      filenameSnapshot: z.string().min(1),
      contentType: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("feedback"),
      quote: z.string().min(1),
      note: z.array(feedbackNotePartSchema).min(1),
      source: z
        .object({
          type: z.literal("mail"),
          id: z.string().min(1),
          status: z.enum(["draft", "sent"]),
          sentId: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

const userMessageDocumentSchema = z
  .object({
    version: z.literal(1),
    parts: z.array(userMessagePartSchema).min(1),
  })
  .strict();

const workflowSnapshotSchema = z.object({
  id: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
  name: z.string(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  automationId: z.string().uuid().optional(),
  triggerBrief: z.string().nullable().optional(),
});

const goalSnapshotSchema = z.object({
  objectiveBrief: z.string().min(1),
});

const chatEventAnnotationSchema = z
  .object({
    kind: z.enum(["slack", "feishu", "teams", "telegram", "github"]),
    href: z.string().url().optional(),
  })
  .strict();

const chatEventBaseSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  content: z.string().nullable(),
  runId: z.string().optional(),
  runGroupId: z.string().optional(),
  triggerSource: triggerSourceSchema.optional(),
  annotation: chatEventAnnotationSchema.optional(),
  isGoalRun: z.boolean().optional(),
  runEventId: z.string().optional(),
  goalSnapshot: goalSnapshotSchema.optional(),
  revokesEventId: z.string().optional(),
  /** Server-assigned strict position within the chat thread. */
  seqId: z.number().int().positive(),
  sequenceNumber: z.number().nullable().optional(),
  workflowSnapshot: workflowSnapshotSchema.optional(),
  createdAt: z.string(),
});

const chatEventRecommendedFollowupSchema = z.object({
  prompt: z.string(),
  kind: z.enum(["talk", "generate"]),
  generationType: z
    .enum(["image", "video", "presentation", "website"])
    .optional(),
});

const chatEventRecommendedFollowupsSchema = z.preprocess((value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const parsed = chatEventRecommendedFollowupSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}, z.array(chatEventRecommendedFollowupSchema));

const inputPromptEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("input.prompt"),
    content: z.null(),
    userMessage: userMessageDocumentSchema,
    attachFiles: z.array(resolvedAttachFileSchema).optional(),
    generationTemplate: generationTemplateRequestSchema.optional(),
  })
  .strict();

const inputAutomationEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("input.automation"),
    content: z.null(),
    automationId: z.string().uuid(),
    triggerSource: triggerSourceSchema,
    triggerBrief: z.string().nullable(),
  })
  .strict();

const inputGoalEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("input.goal"),
    content: z.null(),
    // Queue association stays server-side; the public event preserves only
    // the non-sensitive goal snapshot and stream ordering contract.
    runId: z.never().optional(),
    runGroupId: z.never().optional(),
    triggerSource: z.never().optional(),
    annotation: z.never().optional(),
    isGoalRun: z.never().optional(),
    runEventId: z.never().optional(),
    goalSnapshot: goalSnapshotSchema,
    revokesEventId: z.never().optional(),
    sequenceNumber: z.never().optional(),
    workflowSnapshot: z.never().optional(),
  })
  .strict();

const inputRejectedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("input.rejected"),
    content: z.null(),
    userMessage: userMessageDocumentSchema,
    error: z.string(),
    automationId: z.string().uuid().optional(),
    triggerBrief: z.string().nullable().optional(),
    attachFiles: z.array(resolvedAttachFileSchema).optional(),
    generationTemplate: generationTemplateRequestSchema.optional(),
  })
  .strict();

const outputMessageEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("output.message"),
    content: z.string(),
  })
  .strict();

const outputErrorEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("output.error"),
    error: z.string(),
  })
  .strict();

const outputThinkingEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("output.thinking"),
    content: z.null(),
    thinking: z.string(),
  })
  .strict();

const outputFollowupsEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("output.followups"),
    content: z.null(),
    recommendedFollowups: chatEventRecommendedFollowupsSchema,
  })
  .strict();

const runQueuedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("run.queued"),
    runId: z.string(),
    content: z.string(),
  })
  .strict();

const runDequeuedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("run.dequeued"),
    runId: z.string(),
    content: z.null(),
    revokesEventId: z.string(),
  })
  .strict();

const runCompletedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("run.completed"),
    runId: z.string(),
    attachFiles: z.array(resolvedAttachFileSchema).optional(),
    runLifecycleEvent: z.literal("completed"),
  })
  .strict();

const runFailedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("run.failed"),
    runId: z.string(),
    error: z.string().optional(),
    runLifecycleEvent: z.literal("failed"),
  })
  .strict();

const runCancelledEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("run.cancelled"),
    runId: z.string(),
    error: z.string().optional(),
    runLifecycleEvent: z.literal("cancelled"),
  })
  .strict();

// Read-only leaves for historical queue pause markers, which the API serves
// as part of the complete per-thread event stream. These deliberately stay
// outside CHAT_EVENT_TYPES and chatEventSchema so no current writer or fold
// can recreate the retired pause/resume behavior.
const legacyQueueAutomationPausedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("queue.automation_paused"),
    content: z.null(),
    pauseReason: z.string().nullable(),
  })
  .strict();

const legacyQueueAutomationResumedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("queue.automation_resumed"),
    content: z.null(),
  })
  .strict();

const controlInterruptEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("control.interrupt"),
    content: z.null(),
    interruptsRunId: z.string(),
  })
  .strict();

const controlRevokeEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("control.revoke"),
    content: z.null(),
    revokesEventId: z.string(),
  })
  .strict();

const browserStartedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("browser.started"),
    content: z.null(),
  })
  .strict();

const browserStoppedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("browser.stopped"),
    content: z.null(),
  })
  .strict();

const goalChangedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("goal.changed"),
    content: z.null(),
    goalEvent: zeroGoalEventSchema,
  })
  .strict();

const usageRecordedEventSchema = chatEventBaseSchema
  .extend({
    eventType: z.literal("usage.recorded"),
    runId: z.string(),
    content: z.null(),
    usage: chatEventUsagePayloadSchema,
  })
  .strict();

const chatEventSchema = z.discriminatedUnion("eventType", [
  inputPromptEventSchema,
  inputAutomationEventSchema,
  inputGoalEventSchema,
  inputRejectedEventSchema,
  outputMessageEventSchema,
  outputErrorEventSchema,
  outputThinkingEventSchema,
  outputFollowupsEventSchema,
  runQueuedEventSchema,
  runDequeuedEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runCancelledEventSchema,
  controlInterruptEventSchema,
  controlRevokeEventSchema,
  browserStartedEventSchema,
  browserStoppedEventSchema,
  goalChangedEventSchema,
  usageRecordedEventSchema,
]);

/**
 * Redacted public projection of the canonical thread stream, plus read-only
 * compatibility for retired pause markers from older API deployments.
 * Server-only payload fields are not accepted.
 */
const chatEventResponseSchema = z.discriminatedUnion("eventType", [
  ...chatEventSchema.options,
  legacyQueueAutomationPausedEventSchema,
  legacyQueueAutomationResumedEventSchema,
]);

if (CHAT_EVENT_TYPES.length !== chatEventSchema.options.length) {
  throw new Error(
    "ChatEvent schema must cover every registered event catalog leaf",
  );
}

const chatThreadDetailSchema = z.object({
  /**
   * Read-state watermark. A thread is unread when its latest run-finish marker
   * is newer than this timestamp.
   */
  lastReadAt: z.string().nullable(),
  /**
   * A capable cancelled run is still preserving its resumable session before
   * same-thread continuation can start. Optional during API/Platform rollout.
   */
  cancellationRecoveryPending: z.boolean().optional(),
});

const chatThreadMetadataSchema = z.object({
  id: z.string(),
  // Optional during API/CLI rollout so a newer CLI can fall back to the
  // compact thread snapshot when it reaches an older API.
  agentId: z.string().uuid().optional(),
  title: z.string().nullable(),
  selectedModel: z.string().nullable(),
});

const chatThreadDraftSchema = z
  .object({
    draftUserMessage: userMessageDocumentSchema.nullable(),
    draftAttachments: z.array(persistedAttachmentSchema).nullable(),
  })
  .superRefine(requireUserMessageForDraftAttachments);

const selectedModelRequestSchema = requestedRunModelSchema;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function legacyModelSelectionModel(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const selectedModel = value.selectedModel;
  return typeof selectedModel === "string" ? selectedModel : undefined;
}

function normalizeLegacyModelSelectionInput(
  value: unknown,
  options: { readonly allowNull: boolean },
): unknown {
  if (!isRecord(value) || "model" in value || !("modelSelection" in value)) {
    return value;
  }
  const legacyModelSelection = legacyModelSelectionModel(value.modelSelection);
  if (
    legacyModelSelection === undefined ||
    (legacyModelSelection === null && !options.allowNull)
  ) {
    return value;
  }
  return { ...value, model: legacyModelSelection };
}

const chatThreadCreateBodySchema = z.preprocess(
  (value) => {
    return normalizeLegacyModelSelectionInput(value, { allowNull: false });
  },
  z.object({
    agentId: z.string().min(1),
    clientThreadId: z.string().uuid().optional(),
    eventId: chatThreadEventIdSchema.optional(),
    /**
     * Selected model id. The API resolves the effective model provider from org
     * policy and available credentials. Omit it to inherit the model of the run
     * that owns the calling token; callers without a run must send it.
     */
    model: selectedModelRequestSchema.optional(),
    title: z.string().optional(),
  }),
);

const chatThreadModelSelectionUpdateBodySchema = z.preprocess(
  (value) => {
    return normalizeLegacyModelSelectionInput(value, { allowNull: true });
  },
  z.object({
    /**
     * Selected model id, or null to clear the thread's selected model.
     */
    model: selectedModelRequestSchema.nullable(),
    codexServiceTier: codexServiceTierSchema.nullable().optional(),
    eventId: chatThreadEventIdSchema.optional(),
    serviceTierEventId: chatThreadEventIdSchema.optional(),
  }),
);

const chatRunOptionsRequestSchema = z.object({
  codexServiceTier: codexServiceTierSchema.optional(),
});

const chatNormalSendBodyShape = {
  agentId: z.string().min(1),
  prompt: z.string().min(1),
  threadId: z.string().optional(),
  clientThreadId: z.string().uuid().optional(),
  chatThreadEventId: chatThreadEventIdSchema.optional(),
  // Client-generated UUID for the sort touch created by direct user sends.
  // Lets event-sourced clients reconcile optimistic sidebar recency by id.
  chatThreadSortEventId: chatThreadEventIdSchema.optional(),
  /**
   * Selected model id. The API resolves the effective provider from org
   * policy and available credentials. Existing threads may omit it to
   * reuse the thread's persisted model.
   */
  model: selectedModelRequestSchema.optional(),
  runOptions: chatRunOptionsRequestSchema.optional(),
  userMessage: userMessageDocumentSchema,
  generationTemplate: generationTemplateRequestSchema.optional(),
  computerUseHostId: z.string().uuid().nullable().optional(),
  cloudBrowserEnabled: z.boolean().optional(),
  // Optional for backward compatibility: older clients that omit this field
  // still trigger title generation (server guards with !== false, not === true).
  hasTextContent: z.boolean().optional(),
  attachFiles: z.array(attachFileSchema).optional(),
  // Preview evaluation escape hatch: when enabled, the request asks the
  // runner to bypass preview mock CLIs and use the real agent runtime.
  realAgentInPreview: z.boolean().optional(),
} as const;

const chatEventNormalSendBodySchema = z.preprocess(
  (value) => {
    return normalizeLegacyModelSelectionInput(value, { allowNull: false });
  },
  z
    .object({
      ...chatNormalSendBodyShape,
      // Client-generated UUID used as the user event's primary key.
      clientEventId: z.string().uuid().optional(),
      revokesEventId: z.string().min(1).optional(),
      interruptsRunId: z.undefined().optional(),
    })
    .refine(
      (body) => {
        return !(body.cloudBrowserEnabled && body.computerUseHostId);
      },
      {
        message: "Cloud browser and Computer Use cannot both be enabled",
        path: ["cloudBrowserEnabled"],
      },
    ),
);

/**
 * Chat thread collection route contract.
 */
export const chatThreadsContract = c.router({
  snapshot: {
    method: "GET",
    path: "/api/zero/chat-threads/snapshot",
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        chatThreads: z.array(chatThreadSnapshotProjectionSchema),
        latestEventId: chatThreadEventIdSchema.nullable(),
        // Remove optionality only after pre-sequence APIs cannot serve a newly
        // promoted app during rollout or rollback.
        latestSeqId: z.number().int().positive().nullable().optional(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "Get the compacted chat thread snapshot for the caller's current organization.",
  },
  events: {
    method: "GET",
    path: "/api/zero/chat-threads/events",
    headers: authHeadersSchema,
    query: z.object({
      sinceSeqId: z.coerce.number().int().positive().optional(),
      // Previous clients use UUID cursors. The API resolves them to seq_id
      // until those clients can no longer remain active.
      sinceEventId: chatThreadEventIdSchema.optional(),
    }),
    responses: {
      200: z.object({
        events: z.array(chatThreadEventResponseSchema),
        hasMore: z.boolean(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      410: apiErrorSchema,
    },
    summary: "List chat thread lifecycle events after an optional cursor.",
  },
  activeIds: {
    method: "GET",
    path: "/api/zero/chat-threads/active-ids",
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        threadIds: z.array(z.string().uuid()),
      }),
      401: apiErrorSchema,
    },
    summary:
      "List chat thread ids that currently have queued, pending, or running runs.",
  },
  create: {
    method: "POST",
    path: "/api/zero/chat-threads",
    headers: authHeadersSchema,
    body: chatThreadCreateBodySchema,
    responses: {
      201: z.object({
        id: z.string(),
        title: z.string().nullable(),
        createdAt: z.string(),
        // The model the thread was pinned to, echoed so a caller that omitted
        // `model` learns what it inherited. Remove optionality only after
        // pre-echo APIs cannot serve a newly released CLI during rollout.
        selectedModel: z.string().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create a new chat thread",
  },
  drafts: {
    method: "GET",
    // Sibling path (not nested under /chat-threads/) so it can never
    // collide with the /chat-threads/:id route pattern.
    path: "/api/zero/chat-thread-drafts",
    headers: authHeadersSchema,
    query: z.object({}),
    responses: {
      200: z.object({
        /**
         * Thread ids owned by the caller that currently hold an unsent draft
         * (a user message with optional `draftAttachments`).
         */
        draftThreadIds: z.array(z.string()),
      }),
      401: apiErrorSchema,
    },
    summary:
      "Report which of the caller's chat threads hold an unsent composer draft. Fetched separately from the thread list so the sidebar draft dots don't gate the list query.",
  },
  unreads: {
    method: "GET",
    path: "/api/zero/chat-thread-unreads",
    headers: authHeadersSchema,
    query: z.object({
      agentId: z.string().min(1),
    }),
    responses: {
      200: chatThreadUnreadsSchema,
      401: apiErrorSchema,
    },
    summary:
      "List the caller's unread chat threads under an agent, each with the timestamp of the message that made it unread.",
  },
  unreadAgents: {
    method: "GET",
    path: "/api/zero/chat-thread-unread-agents",
    headers: authHeadersSchema,
    responses: {
      200: chatThreadUnreadAgentsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "List agent IDs with at least one unread chat thread for the caller.",
  },
});

/**
 * Chat thread by ID route contract (/api/chat-threads/[id])
 */
const chatThreadIdPathParamsSchema = z.object({ id: z.string().uuid() });
const chatThreadThreadIdPathParamsSchema = z.object({
  threadId: z.string().uuid(),
});
const chatThreadEventPathParamsSchema =
  chatThreadThreadIdPathParamsSchema.extend({
    eventId: z.string().uuid(),
  });

export const chatThreadByIdContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    responses: {
      200: chatThreadDetailSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get private chat thread state",
  },
  patch: {
    method: "PATCH",
    path: "/api/zero/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: z
      .object({
        draftUserMessage: userMessageDocumentSchema.nullable(),
        draftAttachments: z
          .array(persistedAttachmentSchema)
          .nullable()
          .optional(),
      })
      .superRefine(requireUserMessageForDraftAttachments),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update chat thread draft message and attachments",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/chat-threads/:id",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: z.object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a chat thread",
    body: c.noBody(),
  },
});

/**
 * Thread-scoped composer draft endpoint. Kept separate from thread detail so
 * draft hydration does not require the larger current-thread detail payload.
 */
export const chatThreadDraftContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/chat-threads/:id/draft",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    responses: {
      200: chatThreadDraftSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get chat thread draft content and attachments",
  },
});

/**
 * Mark a chat thread as read up to its current latest run-finish marker.
 * Separate contract so it can be served by its own route file.
 */
export const chatThreadMarkReadContract = c.router({
  markRead: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/mark-read",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: c.noBody(),
    responses: {
      200: z.object({
        lastReadAt: z.string().nullable(),
        /**
         * Fresh unread snapshot for the thread's agent (same shape as the
         * unreads endpoint). Clients should treat
         * `chatThreadReadCursorUpdated` as read-state invalidation.
         */
        unreads: chatThreadUnreadsSchema.shape.unreads,
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Mark a chat thread as read up to the latest run-finish marker",
  },
});

/**
 * Mark every unread chat thread under an agent as read.
 * Separate sibling route so it cannot collide with the `:id` thread routes.
 */
export const chatThreadMarkAgentReadContract = c.router({
  markAgentRead: {
    method: "POST",
    path: "/api/zero/chat-thread-unreads/mark-read",
    headers: authHeadersSchema,
    body: z.object({
      agentId: z.string().min(1),
    }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Mark all unread chat threads under an agent as read",
  },
});

/**
 * Pin / unpin a chat thread. Two separate POST endpoints (no body) instead
 * of widening `chatThreadByIdContract.patch`, which is intentionally narrow
 * (draft fields only). Mirrors the `mark-read` precedent.
 *
 * Split into two contracts because each lives in its own Next.js route
 * folder; `tsr.router` requires every action in a contract to be handled
 * by the same router file.
 */
export const chatThreadPinContract = c.router({
  pin: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/pin",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: z.object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Pin a chat thread to the top of the sidebar",
  },
});

export const chatThreadUnpinContract = c.router({
  unpin: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/unpin",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    query: z.object({ eventId: chatThreadEventIdSchema.optional() }).optional(),
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Remove the pin from a chat thread",
  },
});

/**
 * Rename a chat thread POST endpoint. Sets both the title and the
 * `renamed_at` timestamp, which suppresses future automated title
 * generation for this thread.
 *
 * Split into a dedicated contract/route so any POST body widening
 * (e.g. future `{ icon, folder }` fields) stays invisible to the
 * unrelated draft PATCH on chatThreadByIdContract.
 */
export const chatThreadRenameContract = c.router({
  rename: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/rename",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: z.object({
      title: z.string().min(1),
      eventId: chatThreadEventIdSchema.optional(),
    }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Rename a chat thread (suppresses automated title generation)",
  },
});

/**
 * Narrow metadata endpoint for the current chat thread. This intentionally
 * does not expose messages or detail fields needed by the web UI.
 */
export const chatThreadMetadataContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/chat-threads/:id/metadata",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    responses: {
      200: chatThreadMetadataSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get chat thread metadata",
  },
});

/**
 * Update a chat thread's model pin. Kept separate from
 * `chatThreadByIdContract.patch`, which intentionally remains draft-only.
 */
export const chatThreadModelSelectionContract = c.router({
  update: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/model-selection",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: chatThreadModelSelectionUpdateBodySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update a chat thread model selection",
  },
});

/**
 * Update a chat thread's Computer Use host binding. Kept separate from
 * `chatThreadByIdContract.patch`, which intentionally remains draft-only.
 */
export const chatThreadComputerUseHostContract = c.router({
  update: {
    method: "POST",
    path: "/api/zero/chat-threads/:id/computer-use-host",
    headers: authHeadersSchema,
    pathParams: chatThreadIdPathParamsSchema,
    body: z
      .object({
        computerUseHostId: z.string().uuid().nullable(),
        cloudBrowserEnabled: z.boolean().optional(),
        eventId: chatThreadEventIdSchema.optional(),
      })
      .refine(
        (body) => {
          return !(body.cloudBrowserEnabled && body.computerUseHostId);
        },
        {
          message: "Cloud browser and Computer Use cannot both be enabled",
          path: ["cloudBrowserEnabled"],
        },
      ),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update a chat thread Computer Use host binding",
  },
});

/** Canonical ChatEvent write contract. */
export const chatEventsContract = c.router({
  send: {
    method: "POST",
    path: "/api/zero/chat/events",
    headers: authHeadersSchema,
    body: z.union([
      chatEventNormalSendBodySchema,
      z.object({
        agentId: z.string().min(1),
        threadId: z.string().min(1),
        revokesEventId: z.string().min(1),
        clientEventId: z.string().uuid().optional(),
        prompt: z.undefined().optional(),
        clientThreadId: z.undefined().optional(),
        chatThreadEventId: z.undefined().optional(),
        chatThreadSortEventId: z.undefined().optional(),
        model: z.undefined().optional(),
        runOptions: z.undefined().optional(),
        userMessage: z.undefined().optional(),
        generationTemplate: z.undefined().optional(),
        computerUseHostId: z.undefined().optional(),
        hasTextContent: z.undefined().optional(),
        attachFiles: z.undefined().optional(),
        realAgentInPreview: z.undefined().optional(),
        interruptsRunId: z.undefined().optional(),
      }),
      z.object({
        agentId: z.string().min(1),
        threadId: z.string().min(1),
        interruptsRunId: z.string().uuid(),
        clientEventId: z.string().uuid().optional(),
        prompt: z.undefined().optional(),
        clientThreadId: z.undefined().optional(),
        chatThreadEventId: z.undefined().optional(),
        chatThreadSortEventId: z.undefined().optional(),
        model: z.undefined().optional(),
        runOptions: z.undefined().optional(),
        userMessage: z.undefined().optional(),
        generationTemplate: z.undefined().optional(),
        computerUseHostId: z.undefined().optional(),
        hasTextContent: z.undefined().optional(),
        attachFiles: z.undefined().optional(),
        realAgentInPreview: z.undefined().optional(),
        revokesEventId: z.undefined().optional(),
      }),
    ]),
    responses: {
      201: z.object({
        runId: z.string().nullable(),
        threadId: z.string(),
        status: runStatusSchema.optional(),
        createdAt: z.string().optional(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      422: apiErrorSchema,
    },
    summary: "Append a chat event and dispatch input when applicable",
  },
});

/**
 * Single chat message in a search result.
 * `content` is guaranteed non-null because the search route filters out
 * placeholder rows where content is NULL.
 */
const chatSearchMessageSchema = z.object({
  messageId: z.string(),
  chatThreadId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
  seqId: z.number().int().positive(),
  sequenceNumber: z.number().nullable(),
  runId: z.string().nullable(),
});

const chatSearchResultSchema = z.object({
  chatThreadId: z.string(),
  agentName: z.string(),
  matchedMessage: chatSearchMessageSchema,
  contextBefore: z.array(chatSearchMessageSchema),
  contextAfter: z.array(chatSearchMessageSchema),
});

/**
 * `hasMore` indicates that the server truncated the result set at `limit`.
 * There is intentionally no cursor/offset: `limit` is capped at 50 (see the
 * query schema below) and chat-message search is a lookup tool, not a bulk
 * export. Callers that hit `hasMore=true` should narrow the query (add
 * `agentId`, `since`, or a more specific `keyword`) rather than paginate. If
 * genuine pagination is ever needed, introduce `nextCursor` here — the
 * contract has no external consumers yet, so adding it later is safe.
 */
const chatSearchResponseSchema = z.object({
  results: z.array(chatSearchResultSchema),
  hasMore: z.boolean(),
});

/**
 * Chat search contract (GET /api/zero/chat/search)
 * Searches chat messages within the caller's own threads in the caller's org.
 * Authorization is enforced at the DB query level via userId + orgId filters.
 */
export const chatSearchContract = c.router({
  search: {
    method: "GET",
    path: "/api/zero/chat/search",
    headers: authHeadersSchema,
    query: z.object({
      keyword: z.string().trim().min(1),
      agentId: z.string().uuid().optional(),
      since: z.coerce.number().optional(),
      limit: z.coerce.number().min(1).max(50).default(20),
      before: z.coerce.number().min(0).max(10).default(0),
      after: z.coerce.number().min(0).max(10).default(0),
    }),
    responses: {
      200: chatSearchResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Search chat messages within caller's org (zero proxy)",
  },
});

/** Canonical ChatEvent read contract. */
export const chatThreadEventsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/events",
    headers: authHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    query: z.object({
      sinceSeqId: z.coerce.number().int().positive().optional(),
      beforeSeqId: z.coerce.number().int().positive().optional(),
      sinceId: z.string().uuid().optional(),
      beforeId: z.string().uuid().optional(),
      limit: z.coerce.number().min(1).max(50).default(50),
    }),
    responses: {
      200: z.object({
        events: z.array(chatEventResponseSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get paginated chat events for a thread",
  },
  get: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/events/:eventId",
    headers: authHeadersSchema,
    pathParams: chatThreadEventPathParamsSchema,
    responses: {
      200: chatEventResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a chat event by id for a thread",
  },
});

export const chatThreadArtifactsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/chat-threads/:threadId/artifacts",
    headers: authHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    responses: {
      200: z.object({
        runs: z.array(chatThreadArtifactRunSchema),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List uploaded files associated with every run in a chat thread",
  },
  syncGoogleDrive: {
    method: "POST",
    path: "/api/zero/chat-threads/:threadId/artifacts",
    headers: authHeadersSchema,
    pathParams: chatThreadThreadIdPathParamsSchema,
    body: z.object({
      runId: z.string(),
      fileId: z.string(),
    }),
    responses: {
      200: z.object({
        id: z.string(),
        name: z.string(),
        webViewLink: z.string().nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Sync a chat artifact file to the user's connected Google Drive",
  },
});

export const artifactsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/artifacts",
    headers: authHeadersSchema,
    query: artifactsListQuerySchema,
    responses: {
      200: artifactsListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "List artifacts for the caller's current organization (keyset-paginated)",
  },
  getImageEditSnapshot: {
    method: "GET",
    path: "/api/zero/artifacts/image-edit-snapshot",
    headers: authHeadersSchema,
    query: imageArtifactEditSnapshotQuerySchema,
    responses: {
      200: z.object({ snapshot: imageArtifactEditSnapshotSchema.nullable() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a resumable image artifact edit snapshot for the caller",
  },
  upsertImageEditSnapshot: {
    method: "PUT",
    path: "/api/zero/artifacts/image-edit-snapshot",
    headers: authHeadersSchema,
    body: imageArtifactEditSnapshotUpsertSchema,
    responses: {
      200: imageArtifactEditSnapshotSchema,
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Upsert a resumable image artifact edit snapshot for the caller",
  },
  deleteImageEditSnapshot: {
    method: "DELETE",
    path: "/api/zero/artifacts/image-edit-snapshot",
    headers: authHeadersSchema,
    query: imageArtifactEditSnapshotQuerySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a resumable image artifact edit snapshot for the caller",
  },
});

export type ChatThreadsContract = typeof chatThreadsContract;
export type ChatThreadByIdContract = typeof chatThreadByIdContract;
export type ChatThreadDraftContract = typeof chatThreadDraftContract;
export type ChatThreadMarkReadContract = typeof chatThreadMarkReadContract;
export type ChatThreadMarkAgentReadContract =
  typeof chatThreadMarkAgentReadContract;
export type ChatThreadPinContract = typeof chatThreadPinContract;
export type ChatThreadUnpinContract = typeof chatThreadUnpinContract;
export type ChatThreadRenameContract = typeof chatThreadRenameContract;
export type ChatThreadMetadataContract = typeof chatThreadMetadataContract;
export type ChatThreadModelSelectionContract =
  typeof chatThreadModelSelectionContract;
export type ChatThreadComputerUseHostContract =
  typeof chatThreadComputerUseHostContract;
export type ChatEventsContract = typeof chatEventsContract;
export type ChatThreadEventsContract = typeof chatThreadEventsContract;
export type ChatThreadArtifactsContract = typeof chatThreadArtifactsContract;
export type ArtifactsContract = typeof artifactsContract;
export type ChatSearchContract = typeof chatSearchContract;
export type ChatSearchResponse = z.infer<typeof chatSearchResponseSchema>;
export type ChatSearchResult = z.infer<typeof chatSearchResultSchema>;
export type ChatSearchMessage = z.infer<typeof chatSearchMessageSchema>;

export {
  chatThreadSnapshotProjectionSchema,
  chatThreadEventSchema,
  chatThreadDetailSchema,
  chatThreadMetadataSchema,
  chatThreadDraftSchema,
  chatRunOptionsRequestSchema,
  generationTemplateRequestSchema,
  userMessagePartSchema,
  userMessageDocumentSchema,
  presentationGenerationTemplateRequestSchema,
  videoGenerationTemplateRequestSchema,
  illustrationGenerationTemplateRequestSchema,
  websiteGenerationTemplateRequestSchema,
  chatEventSchema,
  chatEventUsagePayloadSchema,
  summaryEntrySchema,
  persistedAttachmentSchema,
  attachFileSchema,
  resolvedAttachFileSchema,
  artifactItemSchema,
  artifactsListResponseSchema,
  imageArtifactEditSnapshotSchema,
  imageArtifactEditSnapshotStateSchema,
  chatThreadArtifactFileSchema,
  chatThreadArtifactGoogleDriveSyncSchema,
  chatThreadArtifactRunSchema,
  chatEventResponseSchema,
};

export type CodexServiceTier = z.infer<typeof codexServiceTierSchema>;
export type ChatThreadServiceTier = z.infer<typeof chatThreadServiceTierSchema>;
export type ChatRunOptionsRequest = z.infer<typeof chatRunOptionsRequestSchema>;
export type GenerationTemplateRequest = z.infer<
  typeof generationTemplateRequestSchema
>;
export type GenerationTemplateType = GenerationTemplateRequest["type"];
export type FeedbackNotePart = z.infer<typeof feedbackNotePartSchema>;
export type UserMessagePart = z.infer<typeof userMessagePartSchema>;
export type UserMessageDocument = z.infer<typeof userMessageDocumentSchema>;
export type LegacyThreadGenerationTemplateType = Exclude<
  GenerationTemplateType,
  "workflow" | "website"
>;
/**
 * Legacy generation template shape retained for older thread-level storage.
 * Current prompt injection uses the generation template attached to the current
 * message only.
 */
export type ThreadGenerationTemplates = Partial<
  Record<
    LegacyThreadGenerationTemplateType,
    Extract<
      GenerationTemplateRequest,
      { type: LegacyThreadGenerationTemplateType }
    >
  >
>;
export type PresentationGenerationTemplateRequest = z.infer<
  typeof presentationGenerationTemplateRequestSchema
>;
export type VideoGenerationTemplateRequest = z.infer<
  typeof videoGenerationTemplateRequestSchema
>;
export type IllustrationGenerationTemplateRequest = z.infer<
  typeof illustrationGenerationTemplateRequestSchema
>;
export type WorkflowGenerationTemplateRequest = z.infer<
  typeof workflowGenerationTemplateRequestSchema
>;
export type WebsiteGenerationTemplateRequest = z.infer<
  typeof websiteGenerationTemplateRequestSchema
>;

export type SummaryEntry = z.infer<typeof summaryEntrySchema>;
export type ChatThreadSnapshotProjection = z.infer<
  typeof chatThreadSnapshotProjectionSchema
>;
export type ChatThreadEvent = z.infer<typeof chatThreadEventSchema>;
export type ChatThreadDetail = z.infer<typeof chatThreadDetailSchema>;
export type ChatThreadMetadata = z.infer<typeof chatThreadMetadataSchema>;
export type ChatThreadDraft = z.infer<typeof chatThreadDraftSchema>;
export type ChatEvent = z.infer<typeof chatEventSchema>;
export type ChatEventResponse = z.infer<typeof chatEventResponseSchema>;
export type ChatEventSendBody = z.infer<typeof chatEventsContract.send.body>;

export function isCanonicalChatEventResponse(
  event: ChatEventResponse,
): event is ChatEvent {
  return (
    event.eventType !== "queue.automation_paused" &&
    event.eventType !== "queue.automation_resumed"
  );
}

export function chatEventResponse(event: ChatEventResponse): ChatEventResponse {
  return chatEventResponseSchema.parse(event);
}

export type ChatInputEvent = Extract<
  ChatEvent,
  { eventType: "input.prompt" | "input.automation" | "input.rejected" }
>;
export type ChatUserMessageEvent = Extract<
  ChatEvent,
  { eventType: "input.prompt" | "input.rejected" }
>;
export type ChatAutomationEvent = Extract<
  ChatEvent,
  { eventType: "input.automation" }
>;
export type ChatPromptEvent = Extract<ChatEvent, { eventType: "input.prompt" }>;
export type ChatFollowupsEvent = Extract<
  ChatEvent,
  { eventType: "output.followups" }
>;
export type ChatUsageEvent = Extract<
  ChatEvent,
  { eventType: "usage.recorded" }
>;
export type ChatEventUsagePayload = z.infer<typeof chatEventUsagePayloadSchema>;
export type PersistedAttachment = z.infer<typeof persistedAttachmentSchema>;
export type AttachFile = z.infer<typeof attachFileSchema>;
export type AssetRef = z.infer<typeof assetRefSchema>;
export type ResolvedAttachFile = z.infer<typeof resolvedAttachFileSchema>;
export type ChatThreadArtifactFile = z.infer<
  typeof chatThreadArtifactFileSchema
>;
export type ChatThreadArtifactGoogleDriveSync = z.infer<
  typeof chatThreadArtifactGoogleDriveSyncSchema
>;
export type ChatThreadArtifactRun = z.infer<typeof chatThreadArtifactRunSchema>;
export type ArtifactItem = z.infer<typeof artifactItemSchema>;
export type ArtifactsListResponse = z.infer<typeof artifactsListResponseSchema>;
export type ImageArtifactEditSnapshot = z.infer<
  typeof imageArtifactEditSnapshotSchema
>;
export type ImageArtifactEditSnapshotState = z.infer<
  typeof imageArtifactEditSnapshotStateSchema
>;
