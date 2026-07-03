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

export type RelationshipRecord = z.infer<typeof relationshipRecordSchema>;
export type RelationshipResolveResponse = z.infer<
  typeof relationshipResolveResponseSchema
>;
export type RelationshipSearchResponse = z.infer<
  typeof relationshipSearchResponseSchema
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
