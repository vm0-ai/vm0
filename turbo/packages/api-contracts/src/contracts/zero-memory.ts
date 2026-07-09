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

const memorySourceProviderSchema = z.enum([
  "gmail",
  "slack",
  "github",
  "notion",
]);
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
  githubRepository: z.string().optional(),
  githubSubjectKind: z.enum(["issue", "pull_request"]).optional(),
  githubSubjectNumber: z.number().int().positive().optional(),
  githubIssueCommentId: z.string().optional(),
  githubActorLogin: z.string().optional(),
  notionWorkspaceName: z.string().nullable().optional(),
  notionPageId: z.string().optional(),
  notionEventFamily: z
    .enum(["new_child_page", "new_database_item", "page_content_updated"])
    .optional(),
  notionEventType: z
    .enum(["page.created", "page.content_updated", "page.properties_updated"])
    .optional(),
  notionParentTitle: z.string().nullable().optional(),
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
    githubInstallationId: z.string().optional(),
    githubRemoteInstallationId: z.string().optional(),
    githubSubjectUrl: z.string().optional(),
    githubIssueCommentId: z.string().optional(),
    githubActorId: z.string().optional(),
    githubAuthorId: z.string().optional(),
    githubAuthorLogin: z.string().optional(),
    githubLabels: z.array(z.string()).optional(),
    notionWorkspaceId: z.string().optional(),
    notionPageUrl: z.string().nullable().optional(),
    notionLastEditedTime: z.string().nullable().optional(),
    notionEventId: z.string().optional(),
    notionScopeType: z.enum(["page", "data_source"]).optional(),
    notionScopeId: z.string().optional(),
    notionParentUrl: z.string().nullable().optional(),
    notionAuthorIds: z.array(z.string()).optional(),
    reason: z.string().optional(),
  })
  .passthrough();

const memorySourceBaseSchema = z.object({
  id: z.string().uuid(),
  provider: memorySourceProviderSchema,
  sourceType: z.enum([
    "gmail_message",
    "slack_message",
    "github_issue",
    "github_pull_request",
    "github_issue_comment",
    "notion_page",
    "notion_page_event",
  ]),
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

const sourceBackfillStatusSchema = z.enum([
  "idle",
  "pending",
  "running",
  "stopped",
  "done",
  "failed",
]);

const sourceBackfillSchema = z.object({
  status: sourceBackfillStatusSchema,
  estimatedTotal: z.number().int().nonnegative().nullable(),
  scannedCount: z.number().int().nonnegative(),
  recordedCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  updatedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

const githubTrustedContributorSchema = z.object({
  githubUserId: z.string().optional(),
  login: z.string().optional(),
  email: z.string().email().optional(),
});

const githubMemoryRepositoryConfigSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().optional(),
  fullName: z.string().min(1),
  defaultBranch: z.string().nullable().optional(),
  selected: z.boolean(),
  includeIssues: z.boolean().default(true),
  includePullRequests: z.boolean().default(true),
  includeComments: z.boolean().default(true),
  trustedContributors: z.array(githubTrustedContributorSchema).default([]),
});

export const githubMemoryConfigureRequestSchema = z.object({
  repositories: z.array(githubMemoryRepositoryConfigSchema).max(100),
});

export const githubMemoryBackfillRequestSchema = z.object({
  days: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
});

const githubMemoryRepositoryResourceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string().nullable(),
  selected: z.boolean(),
  includeIssues: z.boolean(),
  includePullRequests: z.boolean(),
  includeComments: z.boolean(),
  trustedContributors: z.array(githubTrustedContributorSchema),
});

const githubMemoryContributorSchema = z.object({
  githubUserId: z.string(),
  login: z.string(),
  type: z.string().nullable(),
  contributions: z.number().int().nonnegative().nullable(),
  trusted: z.boolean(),
});

export const githubMemoryRepositoriesResponseSchema = z.object({
  provider: z.literal("github"),
  connected: z.boolean(),
  installationId: z.string().nullable(),
  targetName: z.string().nullable(),
  repositories: z.array(githubMemoryRepositoryResourceSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    hasMore: z.boolean(),
  }),
});

export const githubMemoryContributorsResponseSchema = z.object({
  provider: z.literal("github"),
  connected: z.boolean(),
  repository: z.string(),
  contributors: z.array(githubMemoryContributorSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    hasMore: z.boolean(),
  }),
});

export const githubMemoryStatusResponseSchema = z.object({
  provider: z.literal("github"),
  connected: z.boolean(),
  installationId: z.string().nullable(),
  targetName: z.string().nullable(),
  selectedRepositoryCount: z.number().int().nonnegative(),
  trustedContributorCount: z.number().int().nonnegative(),
  backfill: sourceBackfillSchema,
});

export const notionMemoryBackfillRequestSchema = z.object({
  days: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
  documentLimit: z.number().int().min(1).max(10_000),
});

export const notionMemoryStatusResponseSchema = z.object({
  provider: z.literal("notion"),
  connected: z.boolean(),
  workspaceName: z.string().nullable(),
  backfill: sourceBackfillSchema,
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
export type GithubMemoryConfigureRequest = z.infer<
  typeof githubMemoryConfigureRequestSchema
>;
export type GithubMemoryBackfillRequest = z.infer<
  typeof githubMemoryBackfillRequestSchema
>;
export type GithubMemoryStatusResponse = z.infer<
  typeof githubMemoryStatusResponseSchema
>;
export type GithubMemoryRepositoriesResponse = z.infer<
  typeof githubMemoryRepositoriesResponseSchema
>;
export type GithubMemoryContributorsResponse = z.infer<
  typeof githubMemoryContributorsResponseSchema
>;
export type NotionMemoryBackfillRequest = z.infer<
  typeof notionMemoryBackfillRequestSchema
>;
export type NotionMemoryStatusResponse = z.infer<
  typeof notionMemoryStatusResponseSchema
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
  githubStatus: {
    method: "GET",
    path: "/api/zero/memory/sources/github/status",
    headers: authHeadersSchema,
    responses: {
      200: githubMemoryStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read GitHub memory source configuration and backfill status",
  },
  githubRepositories: {
    method: "GET",
    path: "/api/zero/memory/sources/github/repositories",
    headers: authHeadersSchema,
    query: z.object({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    responses: {
      200: githubMemoryRepositoriesResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List GitHub repositories available for memory source sync",
  },
  githubContributors: {
    method: "GET",
    path: "/api/zero/memory/sources/github/contributors",
    headers: authHeadersSchema,
    query: z.object({
      repository: z.string().min(1),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    responses: {
      200: githubMemoryContributorsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List GitHub contributors for a repository memory allowlist",
  },
  githubConfigure: {
    method: "PUT",
    path: "/api/zero/memory/sources/github/config",
    headers: authHeadersSchema,
    body: githubMemoryConfigureRequestSchema,
    responses: {
      200: githubMemoryStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Configure selected GitHub repositories and trusted contributors",
  },
  githubBackfill: {
    method: "POST",
    path: "/api/zero/memory/sources/github/backfill",
    headers: authHeadersSchema,
    body: githubMemoryBackfillRequestSchema,
    responses: {
      200: githubMemoryStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Start or restart GitHub memory source backfill",
  },
  githubStopBackfill: {
    method: "POST",
    path: "/api/zero/memory/sources/github/backfill/stop",
    headers: authHeadersSchema,
    responses: {
      200: githubMemoryStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Stop the current GitHub memory source backfill",
  },
  notionStatus: {
    method: "GET",
    path: "/api/zero/memory/sources/notion/status",
    headers: authHeadersSchema,
    responses: {
      200: notionMemoryStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read Notion memory source backfill status",
  },
  notionBackfill: {
    method: "POST",
    path: "/api/zero/memory/sources/notion/backfill",
    headers: authHeadersSchema,
    body: notionMemoryBackfillRequestSchema,
    responses: {
      200: notionMemoryStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Start or restart Notion workspace memory source backfill",
  },
  notionStopBackfill: {
    method: "POST",
    path: "/api/zero/memory/sources/notion/backfill/stop",
    headers: authHeadersSchema,
    responses: {
      200: notionMemoryStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Stop the current Notion memory source backfill",
  },
});

export type ZeroMemoryContract = typeof zeroMemoryContract;
