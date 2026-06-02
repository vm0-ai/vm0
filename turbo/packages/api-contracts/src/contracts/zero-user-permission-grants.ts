import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const agentIdSchema = z.string().uuid();
const connectorRefSchema = z.string().min(1).max(64);
const permissionSchema = z.string().min(1).max(128);

export const userPermissionGrantActionSchema = z.enum(["allow", "deny"]);
export const userPermissionGrantTtlSecondsSchema = z.union([
  z.literal(300),
  z.literal(900),
  z.literal(3600),
  z.literal(86_400),
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

export const listUserPermissionGrantsQuerySchema = z.object({
  agentId: agentIdSchema,
});

export const upsertUserPermissionGrantRequestSchema = z.object({
  agentId: agentIdSchema,
  connectorRef: connectorRefSchema,
  permission: permissionSchema,
  action: userPermissionGrantActionSchema,
  ttlSeconds: userPermissionGrantTtlSecondsSchema,
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
});

export type UserPermissionGrantAction = z.infer<
  typeof userPermissionGrantActionSchema
>;
export type UserPermissionGrantTtlSeconds = z.infer<
  typeof userPermissionGrantTtlSecondsSchema
>;
export type UserPermissionGrantResponse = z.infer<
  typeof userPermissionGrantResponseSchema
>;
export type ListUserPermissionGrantsQuery = z.infer<
  typeof listUserPermissionGrantsQuerySchema
>;
export type UpsertUserPermissionGrantRequest = z.infer<
  typeof upsertUserPermissionGrantRequestSchema
>;
export type ZeroUserPermissionGrantsContract =
  typeof zeroUserPermissionGrantsContract;
