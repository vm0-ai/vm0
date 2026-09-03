import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { customConnectorMcpResponseCoreSchema } from "./custom-connectors";

const c = initContract();

export const mcpConnectorSchema = customConnectorMcpResponseCoreSchema.pick({
  id: true,
  slug: true,
  displayName: true,
  transport: true,
  endpoint: true,
  connected: true,
});
export type McpConnector = z.infer<typeof mcpConnectorSchema>;

export const mcpConnectorListResponseSchema = z.object({
  connectors: z.array(mcpConnectorSchema),
});

export const mcpOAuthScopeTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/u);

export const mcpOAuthScopeListSchema = z
  .array(mcpOAuthScopeTokenSchema)
  .min(1)
  .max(100)
  .refine((scopes) => {
    return new Set(scopes).size === scopes.length;
  }, "MCP OAuth scopes must be unique");

export const mcpConnectorOAuthReauthorizationRequestSchema = z.object({
  scopes: mcpOAuthScopeListSchema,
});
export type McpConnectorOAuthReauthorizationRequest = z.infer<
  typeof mcpConnectorOAuthReauthorizationRequestSchema
>;

export const mcpConnectorOAuthReauthorizationResponseSchema = z.object({
  authorizationUrl: z.string().url(),
  expiresAt: z.iso.datetime(),
});
export type McpConnectorOAuthReauthorizationResponse = z.infer<
  typeof mcpConnectorOAuthReauthorizationResponseSchema
>;

export const mcpConnectorsContract = c.router({
  list: {
    method: "GET",
    path: "/api/mcp-connectors",
    headers: authHeadersSchema,
    responses: {
      200: mcpConnectorListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List MCP connectors authorized for the current Agent Run",
  },
  reauthorizeOAuth: {
    method: "POST",
    path: "/api/mcp-connectors/:id/oauth2/reauthorize",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: mcpConnectorOAuthReauthorizationRequestSchema,
    responses: {
      200: mcpConnectorOAuthReauthorizationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Reauthorize MCP OAuth scopes for the current Agent Run",
  },
});

export type McpConnectorsContract = typeof mcpConnectorsContract;
