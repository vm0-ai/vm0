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
});

export type McpConnectorsContract = typeof mcpConnectorsContract;
