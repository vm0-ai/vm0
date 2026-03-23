import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  connectorListResponseSchema,
  connectorTypeSchema,
  scopeDiffResponseSchema,
} from "./connectors";

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
      500: apiErrorSchema,
    },
    summary: "List all connectors (zero proxy)",
  },
});

/**
 * Zero contract for DELETE /api/zero/connectors/:type
 * Proxies to DELETE /api/connectors/:type
 */
export const zeroConnectorsByTypeContract = c.router({
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

export type ZeroConnectorsMainContract = typeof zeroConnectorsMainContract;
export type ZeroConnectorsByTypeContract = typeof zeroConnectorsByTypeContract;
export type ZeroConnectorScopeDiffContract =
  typeof zeroConnectorScopeDiffContract;
export type ZeroConnectorsSearchContract = typeof zeroConnectorsSearchContract;
