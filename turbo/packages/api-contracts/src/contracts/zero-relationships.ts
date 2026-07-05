import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const RELATIONSHIP_SEARCH_DEFAULT_LIMIT = 20;
export const RELATIONSHIP_SEARCH_MAX_LIMIT = 50;
export const RELATIONSHIP_RECENT_INTERACTION_LIMIT = 5;

const relationshipEntitySchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["person", "organization"]),
  displayName: z.string(),
  primaryEmail: z.string().nullable(),
  domain: z.string().nullable(),
});

const relationshipSourceSchema = z.object({
  id: z.string().uuid(),
  provider: z.literal("gmail"),
  externalId: z.string(),
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
  quote: z.string().nullable(),
  occurredAt: z.string().nullable(),
});

const relationshipItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["key_fact", "preference", "open_loop"]),
  text: z.string(),
  confidence: z.number().int().min(0).max(100),
  lastSeenAt: z.string(),
  sources: z.array(relationshipSourceSchema),
});

const relationshipInteractionSchema = z.object({
  id: z.string().uuid(),
  provider: z.literal("gmail"),
  externalId: z.string(),
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
  subject: z.string().nullable(),
  snippet: z.string(),
  occurredAt: z.string(),
});

export const relationshipRecordSchema = z.object({
  id: z.string().uuid(),
  entity: relationshipEntitySchema,
  relationshipType: z.string(),
  status: z.enum(["active", "quiet", "archived"]),
  summary: z.string(),
  lastInteractionAt: z.string().nullable(),
  items: z.array(relationshipItemSchema),
  recentInteractions: z.array(relationshipInteractionSchema),
});

export const relationshipResolveResponseSchema = z.object({
  relationship: relationshipRecordSchema.nullable(),
});

export const relationshipSearchResponseSchema = z.object({
  relationships: z.array(relationshipRecordSchema),
});

export const gmailRelationshipBackfillStatusSchema = z.enum([
  "idle",
  "pending",
  "running",
  "stopped",
  "done",
  "failed",
]);

export const gmailRelationshipBackfillSchema = z.object({
  status: gmailRelationshipBackfillStatusSchema,
  estimatedTotal: z.number().int().nonnegative().nullable(),
  scannedCount: z.number().int().nonnegative(),
  enqueuedCount: z.number().int().nonnegative(),
  pendingSyncJobs: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  updatedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const gmailRelationshipStatusResponseSchema = z.object({
  provider: z.literal("gmail"),
  connectorConnected: z.boolean(),
  enabled: z.boolean(),
  watchEnabled: z.boolean(),
  backfill: gmailRelationshipBackfillSchema,
});

export const gmailRelationshipBackfillRequestSchema = z.object({
  days: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
  includeArchived: z.boolean(),
  includeSent: z.boolean(),
});

export type RelationshipRecord = z.infer<typeof relationshipRecordSchema>;
export type RelationshipResolveResponse = z.infer<
  typeof relationshipResolveResponseSchema
>;
export type RelationshipSearchResponse = z.infer<
  typeof relationshipSearchResponseSchema
>;
export type GmailRelationshipStatusResponse = z.infer<
  typeof gmailRelationshipStatusResponseSchema
>;
export type GmailRelationshipBackfillRequest = z.infer<
  typeof gmailRelationshipBackfillRequestSchema
>;

const resolveQuerySchema = z
  .object({
    id: z.string().uuid().optional(),
    email: z.string().email().optional(),
    domain: z.string().min(1).max(255).optional(),
  })
  .refine(
    (query) => {
      const keys = [query.id, query.email, query.domain].filter(Boolean);
      return keys.length === 1;
    },
    {
      message: "Provide exactly one of id, email, or domain",
    },
  );

export const zeroRelationshipsContract = c.router({
  gmailStatus: {
    method: "GET",
    path: "/api/zero/relationships/gmail/status",
    headers: authHeadersSchema,
    responses: {
      200: gmailRelationshipStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Read Gmail relationship memory enable and backfill status",
  },
  gmailEnable: {
    method: "POST",
    path: "/api/zero/relationships/gmail/enable",
    headers: authHeadersSchema,
    responses: {
      200: gmailRelationshipStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Enable Gmail relationship memory and start backfill",
  },
  gmailBackfill: {
    method: "POST",
    path: "/api/zero/relationships/gmail/backfill",
    headers: authHeadersSchema,
    body: gmailRelationshipBackfillRequestSchema,
    responses: {
      200: gmailRelationshipStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Start or restart Gmail relationship memory backfill",
  },
  gmailStopBackfill: {
    method: "POST",
    path: "/api/zero/relationships/gmail/backfill/stop",
    headers: authHeadersSchema,
    responses: {
      200: gmailRelationshipStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Stop the current Gmail relationship memory backfill",
  },
  gmailDeleteStoppedBackfill: {
    method: "DELETE",
    path: "/api/zero/relationships/gmail/backfill/stopped",
    headers: authHeadersSchema,
    responses: {
      200: gmailRelationshipStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a stopped Gmail relationship memory backfill job",
  },
  resolve: {
    method: "GET",
    path: "/api/zero/relationships/resolve",
    headers: authHeadersSchema,
    query: resolveQuerySchema,
    responses: {
      200: relationshipResolveResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve one relationship in the current organization",
  },
  search: {
    method: "GET",
    path: "/api/zero/relationships/search",
    headers: authHeadersSchema,
    query: z.object({
      q: z.string().max(300).optional(),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(RELATIONSHIP_SEARCH_MAX_LIMIT)
        .default(RELATIONSHIP_SEARCH_DEFAULT_LIMIT),
    }),
    responses: {
      200: relationshipSearchResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Search relationships in the current organization",
  },
});

export type ZeroRelationshipsContract = typeof zeroRelationshipsContract;
