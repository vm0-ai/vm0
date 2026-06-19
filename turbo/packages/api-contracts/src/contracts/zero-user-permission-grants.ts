import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const agentIdSchema = z.string().uuid();
const connectorRefSchema = z.string().min(1).max(64);
const permissionSchema = z.string().min(1).max(128);

export const userPermissionGrantActionSchema = z.enum(["allow", "deny"]);
export const userPermissionGrantExpiresInSchema = z.enum([
  "1h",
  "24h",
  "7d",
  "always",
]);

export const userPermissionGrantResponseSchema = z.object({
  agentId: agentIdSchema,
  connectorRef: connectorRefSchema,
  permission: permissionSchema,
  action: userPermissionGrantActionSchema,
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const userPermissionGrantTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("connector-default") }),
  z.object({
    kind: z.literal("permission"),
    permission: permissionSchema,
  }),
  z.object({ kind: z.literal("unknown-endpoint") }),
]);

export const compactUserPermissionGrantResponseSchema = z.object({
  agentId: agentIdSchema,
  connectorRef: connectorRefSchema,
  target: userPermissionGrantTargetSchema,
  action: userPermissionGrantActionSchema,
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listUserPermissionGrantsQuerySchema = z.object({
  agentId: agentIdSchema,
});

export const resetUserPermissionGrantsQuerySchema = z.object({
  agentId: agentIdSchema,
  connectorRef: connectorRefSchema,
});

export const compactUserPermissionGrantsQuerySchema = z.object({
  agentId: agentIdSchema,
});

const upsertUserPermissionGrantBaseRequestSchema = z.object({
  agentId: agentIdSchema,
  connectorRef: connectorRefSchema,
  permission: permissionSchema,
});

export const upsertUserPermissionGrantRequestSchema = z.discriminatedUnion(
  "action",
  [
    upsertUserPermissionGrantBaseRequestSchema.extend({
      action: z.literal("allow"),
      expiresIn: userPermissionGrantExpiresInSchema.optional(),
    }),
    upsertUserPermissionGrantBaseRequestSchema.extend({
      action: z.literal("deny"),
      expiresIn: z.never().optional(),
    }),
  ],
);

const applyCompactUserPermissionGrantBaseSchema = z.object({
  target: userPermissionGrantTargetSchema,
});

export const applyCompactUserPermissionGrantSchema = z.discriminatedUnion(
  "action",
  [
    applyCompactUserPermissionGrantBaseSchema.extend({
      action: z.literal("allow"),
      expiresIn: userPermissionGrantExpiresInSchema.optional(),
    }),
    applyCompactUserPermissionGrantBaseSchema.extend({
      action: z.literal("deny"),
      expiresIn: z.never().optional(),
    }),
  ],
);

export const applyCompactUserPermissionGrantsRequestSchema = z.object({
  agentId: agentIdSchema,
  connectorRef: connectorRefSchema,
  grants: z.array(applyCompactUserPermissionGrantSchema),
});

export const zeroUserPermissionGrantsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/user-permission-grants",
    headers: authHeadersSchema,
    query: listUserPermissionGrantsQuerySchema,
    responses: {
      200: z.array(userPermissionGrantResponseSchema),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List current user's active permission grants for an agent",
  },
  upsert: {
    method: "PUT",
    path: "/api/zero/user-permission-grants",
    headers: authHeadersSchema,
    body: upsertUserPermissionGrantRequestSchema,
    responses: {
      200: userPermissionGrantResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Upsert current user's permission grant for an agent",
  },
  compactList: {
    method: "GET",
    path: "/api/zero/user-permission-grants/compact",
    headers: authHeadersSchema,
    query: compactUserPermissionGrantsQuerySchema,
    responses: {
      200: z.array(compactUserPermissionGrantResponseSchema),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "List current user's active compact permission grants for an agent",
  },
  compactApply: {
    method: "PUT",
    path: "/api/zero/user-permission-grants/compact",
    headers: authHeadersSchema,
    body: applyCompactUserPermissionGrantsRequestSchema,
    responses: {
      200: z.array(compactUserPermissionGrantResponseSchema),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Replace current user's compact permission grants for a connector",
  },
  reset: {
    method: "DELETE",
    path: "/api/zero/user-permission-grants",
    headers: authHeadersSchema,
    query: resetUserPermissionGrantsQuerySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Reset current user's connector permission grants for an agent",
  },
});

export type UserPermissionGrantAction = z.infer<
  typeof userPermissionGrantActionSchema
>;
export type UserPermissionGrantExpiresIn = z.infer<
  typeof userPermissionGrantExpiresInSchema
>;
export type UserPermissionGrantResponse = z.infer<
  typeof userPermissionGrantResponseSchema
>;
export type UserPermissionGrantTarget = z.infer<
  typeof userPermissionGrantTargetSchema
>;
export type CompactUserPermissionGrantResponse = z.infer<
  typeof compactUserPermissionGrantResponseSchema
>;
export type ListUserPermissionGrantsQuery = z.infer<
  typeof listUserPermissionGrantsQuerySchema
>;
export type CompactUserPermissionGrantsQuery = z.infer<
  typeof compactUserPermissionGrantsQuerySchema
>;
export type ResetUserPermissionGrantsQuery = z.infer<
  typeof resetUserPermissionGrantsQuerySchema
>;
export type UpsertUserPermissionGrantRequest = z.infer<
  typeof upsertUserPermissionGrantRequestSchema
>;
export type ApplyCompactUserPermissionGrant = z.infer<
  typeof applyCompactUserPermissionGrantSchema
>;
export type ApplyCompactUserPermissionGrantsRequest = z.infer<
  typeof applyCompactUserPermissionGrantsRequestSchema
>;
export type ZeroUserPermissionGrantsContract =
  typeof zeroUserPermissionGrantsContract;
