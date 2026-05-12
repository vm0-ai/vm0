import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { connectorTypeSchema } from "@vm0/connectors/connectors";
import {
  computerConnectorCreateResponseSchema,
  connectorListResponseSchema,
  connectorResponseSchema,
  connectorSessionResponseSchema,
  connectorSessionStatusResponseSchema,
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
    pathParams: z.object({ type: connectorTypeSchema }),
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
    pathParams: z.object({ type: connectorTypeSchema }),
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
    pathParams: z.object({ type: connectorTypeSchema }),
    responses: {
      200: scopeDiffResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get scope diff for a connector",
  },
});

const connectorSearchAuthMethodSchema = z.enum(["oauth", "api-token"]);

export type ConnectorSearchAuthMethod = z.infer<
  typeof connectorSearchAuthMethodSchema
>;

const connectorSearchItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  authMethods: z.array(connectorSearchAuthMethodSchema),
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
    },
    summary: "Search available connector types",
  },
});

/**
 * Zero contract for POST /api/zero/connectors/:type/sessions
 * Proxies to POST /api/connectors/:type/sessions (OAuth device flow)
 */
export const zeroConnectorSessionsContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/connectors/:type/sessions",
    headers: authHeadersSchema,
    pathParams: z.object({ type: connectorTypeSchema }),
    body: z.object({}).optional(),
    responses: {
      200: connectorSessionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary: "Create connector session for device flow (zero proxy)",
  },
});

/**
 * Zero contract for GET /api/zero/connectors/:type/sessions/:sessionId
 * Proxies to GET /api/connectors/:type/sessions/:sessionId (poll session)
 */
export const zeroConnectorSessionByIdContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/connectors/:type/sessions/:sessionId",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: connectorTypeSchema,
      sessionId: z.uuid(),
    }),
    responses: {
      200: connectorSessionStatusResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get connector session status (zero proxy)",
  },
});

/**
 * Zero contract for POST/GET/DELETE /api/zero/connectors/computer
 * Proxies to /api/connectors/computer (computer connector CRUD)
 */
export const zeroComputerConnectorContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/connectors/computer",
    headers: authHeadersSchema,
    body: z.object({}).optional(),
    responses: {
      200: computerConnectorCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create computer connector (zero proxy)",
  },
  get: {
    method: "GET",
    path: "/api/zero/connectors/computer",
    headers: authHeadersSchema,
    responses: {
      200: connectorResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get computer connector status (zero proxy)",
  },
  delete: {
    method: "DELETE",
    path: "/api/zero/connectors/computer",
    headers: authHeadersSchema,
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete computer connector (zero proxy)",
  },
});

/**
 * Zero contract for POST /api/zero/connectors/remote-agent
 * Creates the remote-agent connector once the user has at least one online host.
 */
export const zeroRemoteAgentConnectorContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/connectors/remote-agent",
    headers: authHeadersSchema,
    body: z.object({}).optional(),
    responses: {
      200: connectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Connect remote-agent connector",
  },
});

export type ZeroConnectorsMainContract = typeof zeroConnectorsMainContract;
export type ZeroConnectorsByTypeContract = typeof zeroConnectorsByTypeContract;
export type ZeroConnectorScopeDiffContract =
  typeof zeroConnectorScopeDiffContract;
export type ZeroConnectorsSearchContract = typeof zeroConnectorsSearchContract;
export type ZeroConnectorSessionsContract =
  typeof zeroConnectorSessionsContract;
export type ZeroConnectorSessionByIdContract =
  typeof zeroConnectorSessionByIdContract;
export type ZeroComputerConnectorContract =
  typeof zeroComputerConnectorContract;
export type ZeroRemoteAgentConnectorContract =
  typeof zeroRemoteAgentConnectorContract;
