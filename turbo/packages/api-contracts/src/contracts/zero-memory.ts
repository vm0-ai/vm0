import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const memoryFileSchema = z.object({
  path: z.string(),
  size: z.number(),
});

const memoryFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const memorySourceProviderSchema = z.enum(["gmail", "slack"]);
const memoryRecallItemKindSchema = z.enum([
  "key_fact",
  "preference",
  "open_loop",
]);
const memoryInjectionItemKindSchema = z.enum([
  "key_fact",
  "preference",
  "open_loop",
  "role",
  "project",
  "communication_style",
  "recent_context",
]);
const memorySourceDirectionSchema = z.enum([
  "sent",
  "received",
  "mixed",
  "unknown",
]);

const memorySourceCompactMetadataSchema = z.object({
  workspaceId: z.string().optional(),
  channelId: z.string().optional(),
  channelType: z.string().optional(),
  threadId: z.string().nullable().optional(),
  messageTs: z.string().optional(),
  senderId: z.string().optional(),
  mailboxEmail: z.string().optional(),
  direction: memorySourceDirectionSchema.optional(),
});

const memorySourceMetadataSchema = memorySourceCompactMetadataSchema
  .extend({
    messageId: z.string().nullable().optional(),
    participantIds: z.array(z.string()).optional(),
    fileIds: z.array(z.string()).optional(),
    historyId: z.string().optional(),
    from: z.string().nullable().optional(),
    to: z.array(z.string()).optional(),
    cc: z.array(z.string()).optional(),
    reason: z.string().optional(),
  })
  .passthrough();

const memorySourceBaseSchema = z.object({
  id: z.string().uuid(),
  provider: memorySourceProviderSchema,
  sourceType: z.enum(["gmail_message", "slack_message"]),
  title: z.string().nullable(),
  occurredAt: z.string().nullable(),
  createdAt: z.string(),
  contentHash: z.string().nullable(),
});

const memorySourceSchema = memorySourceBaseSchema.extend({
  metadata: memorySourceCompactMetadataSchema,
});

const memorySourceDetailResponseSchema = memorySourceBaseSchema.extend({
  externalId: z.string(),
  connectorId: z.string().uuid().nullable(),
  updatedAt: z.string(),
  metadata: memorySourceMetadataSchema,
});

const memoryRecallRelationshipSchema = z.object({
  id: z.string().uuid(),
  entity: z.object({
    id: z.string().uuid(),
    type: z.enum(["person", "organization"]),
    displayName: z.string(),
    primaryEmail: z.string().nullable(),
    domain: z.string().nullable(),
  }),
  relationshipType: z.string().nullable(),
  status: z.enum(["active", "quiet", "archived"]).nullable(),
  summary: z.string().nullable(),
  lastInteractionAt: z.string().nullable(),
});

const memoryRecallSourceSchema = z.object({
  id: z.string().uuid(),
  provider: memorySourceProviderSchema,
  externalId: z.string(),
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
  quote: z.string().nullable(),
  occurredAt: z.string().nullable(),
});

const memoryRecallItemSchema = z.object({
  id: z.string().uuid(),
  kind: memoryRecallItemKindSchema,
  text: z.string(),
  confidence: z.number().int().min(0).max(100),
  lastSeenAt: z.string(),
  relationship: memoryRecallRelationshipSchema,
  sources: z.array(memoryRecallSourceSchema),
});

export const memoryRecallResponseSchema = z.object({
  query: z.string(),
  memories: z.array(memoryRecallItemSchema),
});

export const memoryContextResponseSchema = z.object({
  query: z.string().nullable(),
  context: z.string(),
  memories: z.array(memoryRecallItemSchema),
});

const memoryInjectionItemSchema = z.object({
  id: z.string().uuid(),
  kind: memoryInjectionItemKindSchema,
  text: z.string(),
  confidence: z.number().int().min(0).max(100),
  lastSeenAt: z.string(),
  entity: z.object({
    id: z.string().uuid(),
    type: z.enum(["person", "organization", "project", "channel"]),
    displayName: z.string(),
  }),
  sources: z.array(memoryRecallSourceSchema),
});

export const memoryInjectionPreviewRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
});

export const memoryInjectionPreviewResponseSchema = z.object({
  prompt: z.string(),
  appendSystemPrompt: z.string(),
  profile: z.object({
    static: z.array(memoryInjectionItemSchema),
    dynamic: z.array(memoryInjectionItemSchema),
  }),
  queryMemories: z.array(memoryInjectionItemSchema),
  stats: z.object({
    injectedCount: z.number().int().nonnegative(),
    omittedCount: z.number().int().nonnegative(),
    characterCount: z.number().int().nonnegative(),
  }),
});

export const memorySourceListResponseSchema = z.object({
  sources: z.array(memorySourceSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().positive(),
    hasMore: z.boolean(),
  }),
});

export const slackMemoryBackfillStatusSchema = z.enum([
  "idle",
  "pending",
  "running",
  "stopped",
  "done",
  "failed",
]);

export const slackMemoryBackfillSchema = z.object({
  status: slackMemoryBackfillStatusSchema,
  estimatedTotal: z.number().int().nonnegative().nullable(),
  scannedCount: z.number().int().nonnegative(),
  recordedCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  updatedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const slackMemoryStatusResponseSchema = z.object({
  provider: z.literal("slack"),
  workspaceConnected: z.boolean(),
  userConnected: z.boolean(),
  workspaceName: z.string().nullable(),
  backfill: slackMemoryBackfillSchema,
});

export const slackMemoryBackfillRequestSchema = z.object({
  days: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
  includePublicChannels: z.boolean(),
  includePrivateChannels: z.boolean(),
  includeDirectMessages: z.boolean(),
});

/**
 * Read-only view of the current user's "memory" artifact (latest version).
 *
 * `exists` is false when the user has never produced memory (no artifact yet);
 * in that case the lists are empty and `updatedAt` is null.
 */
export const memoryDetailResponseSchema = z.object({
  exists: z.boolean(),
  name: z.string(),
  size: z.number(),
  fileCount: z.number(),
  updatedAt: z.string().nullable(),
  files: z.array(memoryFileSchema),
  fileContents: z.array(memoryFileContentSchema),
});

export type MemoryDetailResponse = z.infer<typeof memoryDetailResponseSchema>;
export type MemoryRecallItemKind = z.infer<typeof memoryRecallItemKindSchema>;
export type MemoryRecallItem = z.infer<typeof memoryRecallItemSchema>;
export type MemoryRecallResponse = z.infer<typeof memoryRecallResponseSchema>;
export type MemoryContextResponse = z.infer<typeof memoryContextResponseSchema>;
export type MemoryInjectionItemKind = z.infer<
  typeof memoryInjectionItemKindSchema
>;
export type MemoryInjectionItem = z.infer<typeof memoryInjectionItemSchema>;
export type MemoryInjectionPreviewRequest = z.infer<
  typeof memoryInjectionPreviewRequestSchema
>;
export type MemoryInjectionPreviewResponse = z.infer<
  typeof memoryInjectionPreviewResponseSchema
>;
export type MemorySourceProvider = z.infer<typeof memorySourceProviderSchema>;
export type MemorySourceListResponse = z.infer<
  typeof memorySourceListResponseSchema
>;
export type MemorySourceDetailResponse = z.infer<
  typeof memorySourceDetailResponseSchema
>;
export type SlackMemoryStatusResponse = z.infer<
  typeof slackMemoryStatusResponseSchema
>;
export type SlackMemoryBackfillRequest = z.infer<
  typeof slackMemoryBackfillRequestSchema
>;

/**
 * Zero memory contract for /api/zero/memory
 *
 * GET: Read the current user's memory artifact contents (latest version).
 */
export const zeroMemoryContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/memory",
    headers: authHeadersSchema,
    responses: {
      200: memoryDetailResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get the current user's memory artifact contents",
  },
  recall: {
    method: "GET",
    path: "/api/zero/memory/recall",
    headers: authHeadersSchema,
    query: z.object({
      q: z.string().min(1).max(300),
      kind: memoryRecallItemKindSchema.optional(),
      limit: z.coerce.number().int().min(1).max(25).default(10),
    }),
    responses: {
      200: memoryRecallResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Recall structured memories for the current user",
  },
  context: {
    method: "GET",
    path: "/api/zero/memory/context",
    headers: authHeadersSchema,
    query: z.object({
      q: z.string().min(1).max(300).optional(),
      limit: z.coerce.number().int().min(1).max(30).default(12),
    }),
    responses: {
      200: memoryContextResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get prompt-ready structured memory context for the current user",
  },
  injectionPreview: {
    method: "POST",
    path: "/api/zero/memory/injection-preview",
    headers: authHeadersSchema,
    body: memoryInjectionPreviewRequestSchema,
    responses: {
      200: memoryInjectionPreviewResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Preview relationship memory runtime system prompt injection",
  },
  sources: {
    method: "GET",
    path: "/api/zero/memory/sources",
    headers: authHeadersSchema,
    query: z.object({
      provider: memorySourceProviderSchema.optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    responses: {
      200: memorySourceListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List structured memory sources for the current user",
  },
  source: {
    method: "GET",
    path: "/api/zero/memory/sources/:sourceId",
    pathParams: z.object({
      sourceId: z.string().uuid(),
    }),
    headers: authHeadersSchema,
    responses: {
      200: memorySourceDetailResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get structured memory source details for the current user",
  },
  slackStatus: {
    method: "GET",
    path: "/api/zero/memory/sources/slack/status",
    headers: authHeadersSchema,
    responses: {
      200: slackMemoryStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read Slack memory source backfill status",
  },
  slackBackfill: {
    method: "POST",
    path: "/api/zero/memory/sources/slack/backfill",
    headers: authHeadersSchema,
    body: slackMemoryBackfillRequestSchema,
    responses: {
      200: slackMemoryStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Start or restart Slack memory source backfill",
  },
  slackStopBackfill: {
    method: "POST",
    path: "/api/zero/memory/sources/slack/backfill/stop",
    headers: authHeadersSchema,
    responses: {
      200: slackMemoryStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Stop the current Slack memory source backfill",
  },
});

export type ZeroMemoryContract = typeof zeroMemoryContract;
