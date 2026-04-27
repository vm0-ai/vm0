import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Per-agent custom connector enablement schema.
 * Sparse model: only custom connector ids explicitly enabled by the user
 * for this agent.
 */
export const agentCustomConnectorEnabledIdsSchema = z.object({
  enabledIds: z.array(z.string().uuid()),
});
export type AgentCustomConnectorEnabledIds = z.infer<
  typeof agentCustomConnectorEnabledIdsSchema
>;

/**
 * Contract for GET/PUT /api/zero/agents/:id/custom-connectors
 *
 * Mirrors {@link import("./user-connectors").zeroUserConnectorsContract} but
 * over org custom connector UUIDs (not the built-in ConnectorType enum).
 * A user's secret alone does not authorize an agent — they must also enable
 * the custom connector here for every agent that should use it.
 */
export const zeroAgentCustomConnectorsContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/agents/:id/custom-connectors",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: agentCustomConnectorEnabledIdsSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get enabled custom connector ids for user on agent",
  },
  update: {
    method: "PUT",
    path: "/api/zero/agents/:id/custom-connectors",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: agentCustomConnectorEnabledIdsSchema,
    responses: {
      200: agentCustomConnectorEnabledIdsSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Replace enabled custom connector ids for user on agent",
  },
});
export type ZeroAgentCustomConnectorsContract =
  typeof zeroAgentCustomConnectorsContract;
