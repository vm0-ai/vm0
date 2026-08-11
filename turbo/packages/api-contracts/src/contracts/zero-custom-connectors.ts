import { z } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { connectorOauthCallbackResultSchema } from "./connectors-slug-callback";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const customConnectorSlugSchema = z
  .string()
  .regex(/^_[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$/u);
export type CustomConnectorSlug = z.infer<typeof customConnectorSlugSchema>;

export const customConnectorFieldKindSchema = z.enum(["secret", "variable"]);
export type CustomConnectorFieldKind = z.infer<
  typeof customConnectorFieldKindSchema
>;

export const customConnectorFieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  kind: customConnectorFieldKindSchema,
  required: z.boolean(),
  description: z.string().max(512).optional(),
});
export type CustomConnectorField = z.infer<typeof customConnectorFieldSchema>;

export const customConnectorHeaderInjectionSchema = z.object({
  name: z.string().min(1).max(128),
  valueTemplate: z.string().min(1).max(2048),
});
export type CustomConnectorHeaderInjection = z.infer<
  typeof customConnectorHeaderInjectionSchema
>;

export const customConnectorQueryInjectionSchema = z.object({
  name: z.string().min(1).max(128),
  valueTemplate: z.string().min(1).max(2048),
});
export type CustomConnectorQueryInjection = z.infer<
  typeof customConnectorQueryInjectionSchema
>;

export const customConnectorAuthModeSchema = z.enum(["manual", "oauth"]);
export type CustomConnectorAuthMode = z.infer<
  typeof customConnectorAuthModeSchema
>;

export const customConnectorOAuthProviderAdapterSchema = z.enum([
  "standard",
  "feishu",
]);
export const customConnectorOAuthTokenEndpointAuthMethodSchema = z.enum([
  "client_secret_basic",
  "client_secret_post",
]);
export const customConnectorOAuthPkceMethodSchema = z.enum(["none", "S256"]);

export const customConnectorOAuthConfigSchema = z.object({
  providerAdapter: customConnectorOAuthProviderAdapterSchema,
  clientId: z.string().min(1).max(255),
  authorizationUrl: z.string().url().max(2048),
  tokenUrl: z.string().url().max(2048),
  tokenEndpointAuthMethod: customConnectorOAuthTokenEndpointAuthMethodSchema,
  pkceMethod: customConnectorOAuthPkceMethodSchema,
  scopes: z.array(z.string().min(1).max(256)).max(100),
  authorizationParams: z.record(z.string(), z.string()),
});
export type CustomConnectorOAuthConfig = z.infer<
  typeof customConnectorOAuthConfigSchema
>;

export const customConnectorOAuthConfigInputSchema =
  customConnectorOAuthConfigSchema.extend({
    clientSecret: z.string().min(1).max(4096).optional(),
  });
export type CustomConnectorOAuthConfigInput = z.infer<
  typeof customConnectorOAuthConfigInputSchema
>;

export const customConnectorPermissionBundleRefSchema = z
  .string()
  .max(128)
  .regex(/^builtin:[a-z0-9][a-z0-9-]*@1$/u);
export type CustomConnectorPermissionBundleRef = z.infer<
  typeof customConnectorPermissionBundleRefSchema
>;

const customConnectorPermissionSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().optional(),
});

export const customConnectorPermissionBundleSchema = z.object({
  ref: customConnectorPermissionBundleRefSchema,
  permissions: z.array(customConnectorPermissionSchema),
  defaultPolicies: z.record(z.string(), z.enum(["allow", "deny", "ask"])),
});
export type CustomConnectorPermissionBundleResponse = z.infer<
  typeof customConnectorPermissionBundleSchema
>;

export const customConnectorSkillMarkdownSchema = z.string().refine(
  (value) => {
    return new TextEncoder().encode(value).byteLength <= 65_536;
  },
  { message: "Custom connector skill markdown must not exceed 64 KiB" },
);

export const customConnectorMcpTransportSchema = z.literal("streamable-http");
export type CustomConnectorMcpTransport = z.infer<
  typeof customConnectorMcpTransportSchema
>;

/**
 * Custom connector response — safe to return to any org member.
 * Never includes any secret material.
 */
const customConnectorResponseBaseSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  displayName: z.string(),
  fields: z.array(customConnectorFieldSchema),
  headerInjections: z.array(customConnectorHeaderInjectionSchema),
  queryInjections: z.array(customConnectorQueryInjectionSchema),
  authMode: customConnectorAuthModeSchema.optional(),
  oauthConfig: customConnectorOAuthConfigSchema.optional(),
  permissionBundleRef: customConnectorPermissionBundleRefSchema
    .nullable()
    .optional(),
  skillMarkdown: customConnectorSkillMarkdownSchema.nullable().optional(),
  storageVersion: z.number().int().positive(),
  connected: z.boolean(),
  missingRequiredFields: z.array(z.string()),
  configuredFieldKeys: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  hasSecret: z.boolean(),
});

export const customConnectorHttpResponseSchema =
  customConnectorResponseBaseSchema.extend({
    kind: z.literal("http"),
    prefixTemplates: z.array(z.string()),
  });
export type CustomConnectorHttpResponse = z.infer<
  typeof customConnectorHttpResponseSchema
>;

export const customConnectorMcpResponseSchema =
  customConnectorResponseBaseSchema.extend({
    kind: z.literal("mcp"),
    endpoint: z.string().min(1),
    transport: customConnectorMcpTransportSchema,
    prefixTemplates: z.tuple([]),
    permissionBundleRef: z.null().optional(),
  });
export type CustomConnectorMcpResponse = z.infer<
  typeof customConnectorMcpResponseSchema
>;

const taggedCustomConnectorResponseSchema = z.discriminatedUnion("kind", [
  customConnectorHttpResponseSchema,
  customConnectorMcpResponseSchema,
]);

function normalizeCustomConnectorResponseKind(value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    !("kind" in value) &&
    !("endpoint" in value) &&
    !("transport" in value)
  ) {
    return { ...value, kind: "http" };
  }
  return value;
}

export const customConnectorResponseSchema = z.preprocess(
  normalizeCustomConnectorResponseKind,
  taggedCustomConnectorResponseSchema,
);
export type CustomConnectorResponse = z.infer<
  typeof customConnectorResponseSchema
>;

export function isHttpCustomConnectorResponse(
  connector: CustomConnectorResponse,
): connector is CustomConnectorHttpResponse {
  return connector.kind === "http";
}

export const customConnectorListResponseSchema = z.object({
  connectors: z.array(customConnectorResponseSchema),
});

export const customConnectorHttpClientResponseSchema =
  customConnectorHttpResponseSchema.omit({ hasSecret: true });
export type CustomConnectorHttpClientResponse = z.infer<
  typeof customConnectorHttpClientResponseSchema
>;

export const customConnectorMcpClientResponseSchema =
  customConnectorMcpResponseSchema.omit({ hasSecret: true });
export type CustomConnectorMcpClientResponse = z.infer<
  typeof customConnectorMcpClientResponseSchema
>;

const taggedCustomConnectorClientResponseSchema = z.discriminatedUnion("kind", [
  customConnectorHttpClientResponseSchema,
  customConnectorMcpClientResponseSchema,
]);

export const customConnectorClientResponseSchema = z.preprocess(
  normalizeCustomConnectorResponseKind,
  taggedCustomConnectorClientResponseSchema,
);
export type CustomConnectorClientResponse = z.infer<
  typeof customConnectorClientResponseSchema
>;

export function isHttpCustomConnectorClientResponse(
  connector: CustomConnectorClientResponse,
): connector is CustomConnectorHttpClientResponse {
  return connector.kind === "http";
}

export const customConnectorClientListResponseSchema = z.object({
  connectors: z.array(customConnectorClientResponseSchema),
});

const customConnectorDefinitionWriteBaseSchema = z.object({
  displayName: z.string().min(1).max(128),
  fields: z.array(customConnectorFieldSchema),
  headerInjections: z.array(customConnectorHeaderInjectionSchema),
  queryInjections: z.array(customConnectorQueryInjectionSchema),
  authMode: customConnectorAuthModeSchema.optional(),
  oauthConfig: customConnectorOAuthConfigInputSchema.optional(),
  skillMarkdown: customConnectorSkillMarkdownSchema.nullable().optional(),
  storageVersion: z.number().int().positive().optional(),
});

const customConnectorHttpDefinitionWriteSchema =
  customConnectorDefinitionWriteBaseSchema.extend({
    kind: z.literal("http").optional(),
    prefixTemplates: z.array(z.string().min(1)).min(1),
    permissionBundleRef: customConnectorPermissionBundleRefSchema
      .nullable()
      .optional(),
    endpoint: z.never().optional(),
    transport: z.never().optional(),
  });

export const customConnectorHttpCreateBodySchema =
  customConnectorHttpDefinitionWriteSchema.extend({
    slug: z.string().optional(),
  });

export const customConnectorMcpCreateBodySchema =
  customConnectorDefinitionWriteBaseSchema.extend({
    kind: z.literal("mcp"),
    endpoint: z.string().min(1).max(2048),
    transport: customConnectorMcpTransportSchema,
    permissionBundleRef: z.null().optional(),
    slug: z.string().optional(),
    prefixTemplates: z.never().optional(),
  });

export const createCustomConnectorBodySchema = z.union([
  customConnectorMcpCreateBodySchema,
  customConnectorHttpCreateBodySchema,
]);
export type CreateCustomConnectorBody = z.infer<
  typeof createCustomConnectorBodySchema
>;

export const customConnectorHttpUpdateBodySchema =
  customConnectorHttpDefinitionWriteSchema;

export const customConnectorMcpUpdateBodySchema =
  customConnectorDefinitionWriteBaseSchema.extend({
    kind: z.literal("mcp"),
    endpoint: z.string().min(1).max(2048),
    transport: customConnectorMcpTransportSchema,
    permissionBundleRef: z.null().optional(),
    prefixTemplates: z.never().optional(),
  });

export const updateCustomConnectorBodySchema = z.union([
  customConnectorMcpUpdateBodySchema,
  customConnectorHttpUpdateBodySchema,
]);
/*
 * `kind` is intentionally optional only on the HTTP branches. Installed
 * writers predate the protocol discriminator, while every MCP writer must be
 * explicit so an HTTP-only backend cannot silently create a different shape.
 */
export type UpdateCustomConnectorBody = z.infer<
  typeof updateCustomConnectorBodySchema
>;

export const setCustomConnectorSecretBodySchema = z.object({
  value: z.string().min(1),
});

export const startCustomConnectorOAuth2BodySchema = z
  .object({
    agentId: z.string().uuid().optional(),
  })
  .strict();

export const startCustomConnectorOAuth2ResponseSchema = z.object({
  authorizationUrl: z.string().url(),
});

export const customConnectorValueInputSchema = z.object({
  key: z.string().min(1).max(64),
  kind: customConnectorFieldKindSchema,
  value: z.string().min(1),
});
export type CustomConnectorValueInput = z.infer<
  typeof customConnectorValueInputSchema
>;

export const setCustomConnectorValuesBodySchema = z.object({
  values: z.array(customConnectorValueInputSchema),
});
export type SetCustomConnectorValuesBody = z.infer<
  typeof setCustomConnectorValuesBodySchema
>;

export const customConnectorProposalSchema = z.object({
  operation: z.enum(["create", "update"]),
  connectorId: z.string().uuid().optional(),
  displayName: z.string().min(1).max(128),
  prefixTemplates: z.array(z.string().min(1)).min(1),
  fields: z.array(customConnectorFieldSchema),
  headerInjections: z.array(customConnectorHeaderInjectionSchema),
  queryInjections: z.array(customConnectorQueryInjectionSchema),
  notes: z.string().max(2048).optional(),
});
export type CustomConnectorProposal = z.infer<
  typeof customConnectorProposalSchema
>;

export const saveCustomConnectorProposalBodySchema = z.object({
  proposal: customConnectorProposalSchema,
  values: z.array(customConnectorValueInputSchema),
  agentId: z.string().uuid().optional(),
});
export type SaveCustomConnectorProposalBody = z.infer<
  typeof saveCustomConnectorProposalBodySchema
>;

export const saveCustomConnectorProposalResponseSchema = z.object({
  connector: customConnectorResponseSchema,
  authorizedAgentId: z.string().uuid().optional(),
});
export type SaveCustomConnectorProposalResponse = z.infer<
  typeof saveCustomConnectorProposalResponseSchema
>;

/**
 * Zero custom connectors contract for /api/zero/custom-connectors
 * GET: list all org custom connectors (with per-user hasSecret flag)
 * POST: create a new custom connector (admin only)
 */
export const zeroCustomConnectorsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/custom-connectors",
    headers: authHeadersSchema,
    responses: {
      200: customConnectorListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List org custom connectors",
  },
  create: {
    method: "POST",
    path: "/api/zero/custom-connectors",
    headers: authHeadersSchema,
    body: createCustomConnectorBodySchema,
    responses: {
      201: customConnectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create an org custom connector",
  },
});
export type ZeroCustomConnectorsContract = typeof zeroCustomConnectorsContract;

/**
 * Zero custom connector by id contract for /api/zero/custom-connectors/[id]
 * DELETE: delete a custom connector (admin only — cascades secrets)
 * PUT: update a custom connector definition (admin only)
 */
export const zeroCustomConnectorByIdContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/custom-connectors/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: customConnectorResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get an org custom connector",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/custom-connectors/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete an org custom connector",
  },
  update: {
    method: "PUT",
    path: "/api/zero/custom-connectors/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: updateCustomConnectorBodySchema,
    responses: {
      200: customConnectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update an org custom connector",
  },
  permissions: {
    method: "GET",
    path: "/api/zero/custom-connectors/:id/permissions",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: customConnectorPermissionBundleSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get an org custom connector permission bundle",
  },
});
export type ZeroCustomConnectorByIdContract =
  typeof zeroCustomConnectorByIdContract;

/**
 * Zero custom connector secret contract for /api/zero/custom-connectors/[id]/secret
 * PUT: set the calling user's secret for this connector
 * DELETE: disconnect the calling user's complete connector connection
 */
export const zeroCustomConnectorSecretContract = c.router({
  set: {
    method: "PUT",
    path: "/api/zero/custom-connectors/:id/secret",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: setCustomConnectorSecretBodySchema,
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set the calling user's secret for a custom connector",
  },
  disconnect: {
    method: "DELETE",
    path: "/api/zero/custom-connectors/:id/secret",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Disconnect the calling user's custom connector connection",
  },
});
export type ZeroCustomConnectorSecretContract =
  typeof zeroCustomConnectorSecretContract;

export const zeroCustomConnectorConnectionContract = c.router({
  disconnect: {
    method: "DELETE",
    path: "/api/zero/custom-connectors/:id/connection",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Disconnect the calling user's custom connector connection",
  },
});
export type ZeroCustomConnectorConnectionContract =
  typeof zeroCustomConnectorConnectionContract;

export const zeroCustomConnectorValuesContract = c.router({
  set: {
    method: "PUT",
    path: "/api/zero/custom-connectors/:id/values",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: setCustomConnectorValuesBodySchema,
    responses: {
      200: customConnectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set the calling user's values for a custom connector",
  },
});
export type ZeroCustomConnectorValuesContract =
  typeof zeroCustomConnectorValuesContract;

export const zeroCustomConnectorOAuth2Contract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/custom-connectors/:id/oauth2/start",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: startCustomConnectorOAuth2BodySchema,
    responses: {
      200: startCustomConnectorOAuth2ResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Start OAuth 2.0 for a custom connector",
  },
  callback: {
    method: "GET",
    path: "/api/zero/custom-connectors/oauth2/callback",
    query: z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
        responseMode: z.literal("json").optional(),
      })
      .catchall(z.string()),
    responses: {
      200: connectorOauthCallbackResultSchema,
      307: c.noBody(),
    },
    summary: "Complete OAuth 2.0 for a custom connector",
  },
});
export type ZeroCustomConnectorOAuth2Contract =
  typeof zeroCustomConnectorOAuth2Contract;

export const zeroCustomConnectorProposalContract = c.router({
  save: {
    method: "POST",
    path: "/api/zero/custom-connectors/proposals/save",
    headers: authHeadersSchema,
    body: saveCustomConnectorProposalBodySchema,
    responses: {
      200: saveCustomConnectorProposalResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Save a custom connector proposal",
  },
});
export type ZeroCustomConnectorProposalContract =
  typeof zeroCustomConnectorProposalContract;
