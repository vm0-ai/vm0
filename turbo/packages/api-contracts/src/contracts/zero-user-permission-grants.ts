import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";

const c = initContract();

const agentIdSchema = z.string().uuid();
const permissionSchema = z.string().min(1).max(128);

export const userPermissionGrantActionSchema = z.enum(["allow", "deny"]);
export const userPermissionGrantApplyModeSchema = z.enum(["patch", "replace"]);
export const userPermissionGrantExpiresInSchema = z.enum([
  "1h",
  "24h",
  "7d",
  "always",
]);

const agentPermissionGrantScopeSchema = z.object({
  agentId: agentIdSchema,
});

export const userPermissionGrantScopeSchema = agentPermissionGrantScopeSchema;

const userPermissionGrantResponseBaseSchema = z.object({
  // TODO(#23821): Remove this legacy wire field after clients migrate.
  connectorRef: connectorSlugSchema,
  connectorSlug: connectorSlugSchema.optional(),
  permission: permissionSchema,
  action: userPermissionGrantActionSchema,
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const userPermissionGrantResponseSchema =
  userPermissionGrantResponseBaseSchema.extend({
    agentId: agentIdSchema,
  });

const listUserPermissionGrantsQuerySchema = userPermissionGrantScopeSchema;

const applyUserPermissionGrantBaseSchema = z.object({
  permission: permissionSchema,
});

export const applyUserPermissionGrantSchema = z.discriminatedUnion("action", [
  applyUserPermissionGrantBaseSchema.extend({
    action: z.literal("allow"),
    expiresIn: userPermissionGrantExpiresInSchema.optional(),
  }),
  applyUserPermissionGrantBaseSchema.extend({
    action: z.literal("deny"),
    expiresIn: z.never().optional(),
  }),
]);

export const applyUserPermissionGrantsRequestSchema = z
  .object({
    agentId: agentIdSchema,
    // TODO(#23821): Remove this legacy wire field after clients migrate.
    connectorRef: connectorSlugSchema.optional(),
    connectorSlug: connectorSlugSchema.optional(),
    mode: userPermissionGrantApplyModeSchema,
    grants: z.array(applyUserPermissionGrantSchema),
  })
  .superRefine((request, ctx) => {
    if (
      request.connectorRef === undefined &&
      request.connectorSlug === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "connectorRef or connectorSlug is required",
        path: ["connectorSlug"],
      });
    }
    if (
      request.connectorRef !== undefined &&
      request.connectorSlug !== undefined &&
      request.connectorRef !== request.connectorSlug
    ) {
      ctx.addIssue({
        code: "custom",
        message: "connectorRef and connectorSlug must match",
        path: ["connectorSlug"],
      });
    }
  })
  .transform(({ connectorRef, connectorSlug, ...request }) => {
    const normalizedConnectorSlug = connectorSlug ?? connectorRef ?? "";
    return {
      ...request,
      connectorRef: normalizedConnectorSlug,
      connectorSlug: normalizedConnectorSlug,
    };
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
  apply: {
    method: "PUT",
    path: "/api/zero/user-permission-grants/apply",
    headers: authHeadersSchema,
    body: applyUserPermissionGrantsRequestSchema,
    responses: {
      200: z.array(userPermissionGrantResponseSchema),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Apply current user's explicit permission grant changes for one connector",
  },
});

export type UserPermissionGrantAction = z.infer<
  typeof userPermissionGrantActionSchema
>;
export type UserPermissionGrantApplyMode = z.infer<
  typeof userPermissionGrantApplyModeSchema
>;
export type UserPermissionGrantExpiresIn = z.infer<
  typeof userPermissionGrantExpiresInSchema
>;
export type UserPermissionGrantResponse = z.infer<
  typeof userPermissionGrantResponseSchema
>;
export type ListUserPermissionGrantsQuery = z.infer<
  typeof listUserPermissionGrantsQuerySchema
>;
export type ApplyUserPermissionGrant = z.infer<
  typeof applyUserPermissionGrantSchema
>;
export type ApplyUserPermissionGrantsRequest = z.input<
  typeof applyUserPermissionGrantsRequestSchema
>;
export type NormalizedApplyUserPermissionGrantsRequest = z.output<
  typeof applyUserPermissionGrantsRequestSchema
>;
export type ZeroUserPermissionGrantsContract =
  typeof zeroUserPermissionGrantsContract;
