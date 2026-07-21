import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import {
  connectorAuthMethodIdSchema,
  connectorRefSchema,
} from "./connector-identity";
import { apiErrorSchema } from "./errors";
import {
  connectorOauthDeviceAuthSessionPollRequestSchema,
  connectorOauthDeviceAuthSessionPollResponseSchema,
  connectorOauthDeviceAuthSessionStartResponseSchema,
  connectorExternalCodeSessionCompleteRequestSchema,
  connectorExternalCodeSessionCompleteResponseSchema,
  connectorExternalCodeSessionStartResponseSchema,
  connectorOauthStartResponseSchema,
  connectorListResponseSchema,
  connectorResponseSchema,
  scopeDiffResponseSchema,
} from "./connector-schemas";

const c = initContract();

/**
 * Zero contract for GET /api/zero/connectors
 * Proxies to GET /api/connectors
 */
export const zeroConnectorsMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/connectors",
    headers: authHeadersSchema,
    responses: {
      200: connectorListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all connectors (zero proxy)",
  },
});

/**
 * Zero contract for GET/DELETE /api/zero/connectors/:type
 * Proxies to GET/DELETE /api/connectors/:type
 */
export const zeroConnectorsByTypeContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/connectors/:type",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorRefSchema }),
    responses: {
      200: connectorResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get connector by type (zero proxy)",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/connectors/:type",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorRefSchema }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect a connector (zero proxy)",
  },
});

/**
 * Zero contract for GET /api/zero/connectors/:type/scope-diff
 * App-layer endpoint (direct service call, no proxy)
 */
export const zeroConnectorScopeDiffContract = c.router({
  getScopeDiff: {
    method: "GET",
    path: "/api/zero/connectors/:type/scope-diff",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorRefSchema }),
    responses: {
      200: scopeDiffResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get scope diff for a connector",
  },
});

export const zeroConnectorOauthStartContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/connectors/:type/oauth/start",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorRefSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
    }),
    responses: {
      200: connectorOauthStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create connector OAuth handoff and authorization URL",
  },
});

export const zeroConnectorOpenIdStartContract = c.router({
  start: {
    method: "POST",
    path: "/api/zero/connectors/:type/openid/start",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorRefSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
    }),
    responses: {
      200: connectorOauthStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create connector OpenID handoff and authorization URL",
  },
});

export const zeroConnectorManualGrantContract = c.router({
  connect: {
    method: "POST",
    path: "/api/zero/connectors/:type/manual-grant",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorRefSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
      values: z.record(z.string(), z.string()),
    }),
    responses: {
      200: connectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Connect a connector with a manual grant",
  },
});

export const zeroConnectorNoAuthGrantContract = c.router({
  connect: {
    method: "POST",
    path: "/api/zero/connectors/:type/no-auth",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorRefSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
    }),
    responses: {
      200: connectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Enable a connector with a no-auth grant",
  },
});

export const zeroConnectorOauthDeviceAuthSessionContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/connectors/:type/oauth/device/sessions",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorRefSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
      options: z.record(z.string(), z.string()).optional(),
    }),
    responses: {
      200: connectorOauthDeviceAuthSessionStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create connector OAuth device authorization session",
  },
  poll: {
    method: "POST",
    path: "/api/zero/connectors/:type/oauth/device/sessions/:sessionId/poll",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorRefSchema,
      sessionId: z.uuid(),
    }),
    body: connectorOauthDeviceAuthSessionPollRequestSchema,
    responses: {
      200: connectorOauthDeviceAuthSessionPollResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Poll connector OAuth device authorization session",
  },
});

export const zeroConnectorExternalCodeSessionContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/connectors/:type/external-code/sessions",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorRefSchema }),
    body: z.object({
      authMethod: connectorAuthMethodIdSchema,
      agentId: z.uuid().optional(),
      authorizeAgent: z.literal(true).optional(),
    }),
    responses: {
      200: connectorExternalCodeSessionStartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create connector external-code authorization session",
  },
  complete: {
    method: "POST",
    path: "/api/zero/connectors/:type/external-code/sessions/:sessionId/complete",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorRefSchema,
      sessionId: z.uuid(),
    }),
    body: connectorExternalCodeSessionCompleteRequestSchema,
    responses: {
      200: connectorExternalCodeSessionCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Complete connector external-code authorization session",
  },
});

export type ConnectorSearchAuthMethod = z.infer<
  typeof connectorAuthMethodIdSchema
>;

const connectorSearchItemSchema = z.object({
  id: connectorRefSchema,
  label: z.string(),
  description: z.string(),
  authMethods: z.array(connectorAuthMethodIdSchema),
});

const connectorSearchResponseSchema = z.object({
  connectors: z.array(connectorSearchItemSchema),
});

export type ConnectorSearchItem = z.infer<typeof connectorSearchItemSchema>;
export type ConnectorSearchResponse = z.infer<
  typeof connectorSearchResponseSchema
>;

/**
 * Zero contract for GET /api/zero/connectors/search
 * Returns all available connector type definitions with optional keyword search
 */
export const zeroConnectorsSearchContract = c.router({
  search: {
    method: "GET",
    path: "/api/zero/connectors/search",
    headers: authHeadersSchema,
    query: z.object({ keyword: z.string().optional() }),
    responses: {
      200: connectorSearchResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Search available connector types",
  },
});

export type ZeroConnectorsMainContract = typeof zeroConnectorsMainContract;
export type ZeroConnectorsByTypeContract = typeof zeroConnectorsByTypeContract;
export type ZeroConnectorScopeDiffContract =
  typeof zeroConnectorScopeDiffContract;
export type ZeroConnectorManualGrantContract =
  typeof zeroConnectorManualGrantContract;
export type ZeroConnectorNoAuthGrantContract =
  typeof zeroConnectorNoAuthGrantContract;
export type ZeroConnectorOauthDeviceAuthSessionContract =
  typeof zeroConnectorOauthDeviceAuthSessionContract;
export type ZeroConnectorExternalCodeSessionContract =
  typeof zeroConnectorExternalCodeSessionContract;
export type ZeroConnectorsSearchContract = typeof zeroConnectorsSearchContract;
