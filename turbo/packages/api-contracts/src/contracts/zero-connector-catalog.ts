import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorReconnectReasonSchema } from "./connector-schemas";
import { connectorRefSchema } from "./connector-ref";
import { apiErrorSchema } from "./errors";

const c = initContract();

const publicConnectorCatalogAuthMethodSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  grantKind: z.enum([
    "manual",
    "auth-code",
    "external-code",
    "device-auth",
    "managed",
  ]),
});

const publicConnectorCatalogPermissionSummarySchema = z.object({
  hasPermissions: z.boolean(),
  permissionCount: z.number().int().nonnegative(),
  hasCategories: z.boolean(),
  hasDefaultPolicyOverrides: z.boolean(),
});

const publicConnectorCatalogCategoryGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  menuLabel: z.string(),
});

const publicConnectorCatalogCategorySchema = z.object({
  id: z.string(),
  label: z.string(),
  menuLabel: z.string(),
  groupId: z.string().nullable(),
});

const publicConnectorCatalogCategoryMetadataSchema = z.object({
  categories: z.array(publicConnectorCatalogCategorySchema),
  groups: z.array(publicConnectorCatalogCategoryGroupSchema),
});

const publicConnectorCatalogItemSchema = z.object({
  connectorRef: connectorRefSchema,
  label: z.string(),
  description: z.string(),
  category: z.string(),
  generation: z.array(z.string()),
  tags: z.array(z.string()),
  authMethods: z.array(publicConnectorCatalogAuthMethodSummarySchema),
  permissionSummary: publicConnectorCatalogPermissionSummarySchema,
});

const publicConnectorCatalogManualFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  required: z.boolean(),
  placeholder: z.string().nullable(),
  inputType: z.enum(["password", "text"]),
});

const publicConnectorCatalogStartOptionChoiceSchema = z.object({
  value: z.string(),
  label: z.string(),
});

const publicConnectorCatalogStartOptionSchema = z.object({
  id: z.string(),
  kind: z.literal("select"),
  label: z.string(),
  required: z.boolean(),
  defaultValue: z.string().nullable(),
  options: z.array(publicConnectorCatalogStartOptionChoiceSchema),
});

const publicConnectorCatalogAuthMethodDetailSchema =
  publicConnectorCatalogAuthMethodSummarySchema.extend({
    manualFields: z.array(publicConnectorCatalogManualFieldSchema),
    startOptions: z.array(publicConnectorCatalogStartOptionSchema),
  });

const publicConnectorCatalogDetailSchema =
  publicConnectorCatalogItemSchema.extend({
    authMethods: z.array(publicConnectorCatalogAuthMethodDetailSchema),
  });

const publicConnectorCatalogListResponseSchema = z.object({
  connectors: z.array(publicConnectorCatalogItemSchema),
  categoryMetadata: publicConnectorCatalogCategoryMetadataSchema.optional(),
});

const publicConnectorCatalogDetailResponseSchema = z.object({
  connector: publicConnectorCatalogDetailSchema,
});

const publicConnectorCatalogConnectionStatusSchema = z.enum([
  "not-connected",
  "connected",
  "scope-mismatch",
  "reconnect-required",
]);

const publicConnectorCatalogConnectionSchema = z.object({
  authMethod: z.string(),
  externalUsername: z.string().nullable(),
  externalEmail: z.string().nullable(),
  reconnectReason: connectorReconnectReasonSchema.nullable(),
});

const publicConnectorCatalogStatusItemSchema =
  publicConnectorCatalogDetailSchema.extend({
    connection: publicConnectorCatalogConnectionSchema.nullable(),
    connected: z.boolean(),
    connectionStatus: publicConnectorCatalogConnectionStatusSchema,
    scopeMismatch: z.boolean(),
    authMethodSupportsRefresh: z.boolean(),
    tokenExpiresAt: z.string().nullable(),
    singleAuthCodeAuthMethodId: z.string().nullable(),
    connectNotice: z.enum(["google-security-warning"]).nullable(),
  });

const publicConnectorCatalogStatusResponseSchema = z.object({
  connectors: z.array(publicConnectorCatalogStatusItemSchema),
  categoryMetadata: publicConnectorCatalogCategoryMetadataSchema.optional(),
});

const publicFirewallPolicyValueSchema = z.enum(["allow", "deny", "ask"]);

const publicConnectorCatalogPermissionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

const publicConnectorCatalogPermissionCategoriesSchema = z.object({
  categories: z.record(z.string(), z.string()),
  displayOrder: z.array(z.string()),
});

const publicConnectorCatalogDefaultPolicySchema = z.object({
  permissionDefault: publicFirewallPolicyValueSchema,
  permissionOverrides: z.record(z.string(), z.array(z.string())).optional(),
  unknownPolicy: publicFirewallPolicyValueSchema,
});

const publicConnectorCatalogPermissionDetailSchema = z.object({
  connectorRef: connectorRefSchema,
  label: z.string(),
  permissionCount: z.number().int().nonnegative(),
  permissions: z.array(publicConnectorCatalogPermissionSchema),
  categories: publicConnectorCatalogPermissionCategoriesSchema.nullable(),
  defaultPolicy: publicConnectorCatalogDefaultPolicySchema,
});

const publicConnectorCatalogPermissionDetailResponseSchema = z.object({
  permissions: publicConnectorCatalogPermissionDetailSchema,
});

const connectorCatalogPathParamsSchema = z.object({
  connectorRef: connectorRefSchema,
});

export type PublicConnectorCatalogAuthMethodSummary = z.infer<
  typeof publicConnectorCatalogAuthMethodSummarySchema
>;
export type PublicConnectorCatalogPermissionSummary = z.infer<
  typeof publicConnectorCatalogPermissionSummarySchema
>;
export type PublicConnectorCatalogCategoryGroup = z.infer<
  typeof publicConnectorCatalogCategoryGroupSchema
>;
export type PublicConnectorCatalogCategory = z.infer<
  typeof publicConnectorCatalogCategorySchema
>;
export type PublicConnectorCatalogCategoryMetadata = z.infer<
  typeof publicConnectorCatalogCategoryMetadataSchema
>;
export type PublicConnectorCatalogItem = z.infer<
  typeof publicConnectorCatalogItemSchema
>;
export type PublicConnectorCatalogManualField = z.infer<
  typeof publicConnectorCatalogManualFieldSchema
>;
export type PublicConnectorCatalogStartOption = z.infer<
  typeof publicConnectorCatalogStartOptionSchema
>;
export type PublicConnectorCatalogAuthMethodDetail = z.infer<
  typeof publicConnectorCatalogAuthMethodDetailSchema
>;
export type PublicConnectorCatalogDetail = z.infer<
  typeof publicConnectorCatalogDetailSchema
>;
export type PublicConnectorCatalogListResponse = z.infer<
  typeof publicConnectorCatalogListResponseSchema
>;
export type PublicConnectorCatalogDetailResponse = z.infer<
  typeof publicConnectorCatalogDetailResponseSchema
>;
export type PublicConnectorCatalogConnectionStatus = z.infer<
  typeof publicConnectorCatalogConnectionStatusSchema
>;
export type PublicConnectorCatalogConnection = z.infer<
  typeof publicConnectorCatalogConnectionSchema
>;
export type PublicConnectorCatalogStatusItem = z.infer<
  typeof publicConnectorCatalogStatusItemSchema
>;
export type PublicConnectorCatalogStatusResponse = z.infer<
  typeof publicConnectorCatalogStatusResponseSchema
>;
export type PublicConnectorCatalogPermissionDetail = z.infer<
  typeof publicConnectorCatalogPermissionDetailSchema
>;
export type PublicConnectorCatalogPermissionDetailResponse = z.infer<
  typeof publicConnectorCatalogPermissionDetailResponseSchema
>;

export const zeroConnectorCatalogContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/connector-catalog",
    headers: authHeadersSchema,
    responses: {
      200: publicConnectorCatalogListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List public connector catalog metadata",
  },
  status: {
    method: "GET",
    path: "/api/zero/connector-catalog/status",
    headers: authHeadersSchema,
    responses: {
      200: publicConnectorCatalogStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List public connector catalog metadata with connection status",
  },
  get: {
    method: "GET",
    path: "/api/zero/connector-catalog/:connectorRef",
    headers: authHeadersSchema,
    pathParams: connectorCatalogPathParamsSchema,
    responses: {
      200: publicConnectorCatalogDetailResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get public connector catalog metadata",
  },
  permissions: {
    method: "GET",
    path: "/api/zero/connector-catalog/:connectorRef/permissions",
    headers: authHeadersSchema,
    pathParams: connectorCatalogPathParamsSchema,
    responses: {
      200: publicConnectorCatalogPermissionDetailResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get public connector permission metadata",
  },
});

export type ZeroConnectorCatalogContract = typeof zeroConnectorCatalogContract;
