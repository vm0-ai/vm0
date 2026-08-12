import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { customConnectorMcpClientResponseSchema } from "./zero-custom-connectors";

const c = initContract();

export const zeroMcpConnectorSchema =
  customConnectorMcpClientResponseSchema.pick({
    id: true,
    slug: true,
    displayName: true,
    transport: true,
    endpoint: true,
    connected: true,
  });
export type ZeroMcpConnector = z.infer<typeof zeroMcpConnectorSchema>;

export const zeroMcpConnectorListResponseSchema = z.object({
  connectors: z.array(zeroMcpConnectorSchema),
});

export const zeroMcpConnectorsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/mcp-connectors",
    headers: authHeadersSchema,
    responses: {
      200: zeroMcpConnectorListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List MCP connectors authorized for the current Agent Run",
  },
});

export type ZeroMcpConnectorsContract = typeof zeroMcpConnectorsContract;
