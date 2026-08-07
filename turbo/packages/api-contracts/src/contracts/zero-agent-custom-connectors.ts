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

export const agentCustomConnectorGrantSchema = z.object({
  customConnectorId: z.string().uuid(),
  permissionNames: z.array(z.string().min(1).max(128)).max(500),
});
export type AgentCustomConnectorGrant = z.infer<
  typeof agentCustomConnectorGrantSchema
>;

export const agentCustomConnectorGrantsSchema = z.object({
  grants: z.array(agentCustomConnectorGrantSchema),
});
export type AgentCustomConnectorGrants = z.infer<
  typeof agentCustomConnectorGrantsSchema
>;

export const agentCustomConnectorResponseSchema =
  agentCustomConnectorEnabledIdsSchema.extend({
    grants: z.array(agentCustomConnectorGrantSchema).optional(),
  });
export type AgentCustomConnectorResponse = z.infer<
  typeof agentCustomConnectorResponseSchema
>;

const legacyAgentCustomConnectorUpdateSchema =
  agentCustomConnectorEnabledIdsSchema
    .extend({
      operation: z.enum(["replace", "add", "remove"]).optional(),
    })
    .strict();

const permissionedAgentCustomConnectorUpdateSchema =
  agentCustomConnectorGrantsSchema
    .extend({
      operation: z.enum(["replace", "add", "remove"]).optional(),
    })
    .strict();

export const agentCustomConnectorUpdateSchema = z.union([
  legacyAgentCustomConnectorUpdateSchema,
  permissionedAgentCustomConnectorUpdateSchema,
]);
export type AgentCustomConnectorUpdate = z.infer<
  typeof agentCustomConnectorUpdateSchema
>;

/**
 * Contract for GET/PUT /api/zero/agents/:id/custom-connectors
 *
 * Mirrors {@link import("./user-connectors").zeroUserConnectorsContract} but
 * over org custom connector UUIDs (not official connector slugs).
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
      200: agentCustomConnectorResponseSchema,
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
    body: agentCustomConnectorUpdateSchema,
    responses: {
      200: agentCustomConnectorResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update enabled custom connector ids for user on agent",
  },
});
export type ZeroAgentCustomConnectorsContract =
  typeof zeroAgentCustomConnectorsContract;
