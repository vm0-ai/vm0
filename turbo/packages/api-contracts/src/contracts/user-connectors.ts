import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * User connector enabled types schema
 * Sparse model: only connector types explicitly enabled by the user for this
 * agent.
 */
export const userConnectorEnabledTypesSchema = z.object({
  enabledTypes: z.array(z.string()),
});
export type UserConnectorEnabledTypes = z.infer<
  typeof userConnectorEnabledTypesSchema
>;

export const userConnectorUpdateSchema = userConnectorEnabledTypesSchema.extend(
  {
    operation: z.enum(["replace", "add", "remove"]).optional(),
  },
);
export type UserConnectorUpdate = z.infer<typeof userConnectorUpdateSchema>;

/**
 * Contract for GET/PUT /api/zero/agents/:id/user-connectors
 */
export const zeroUserConnectorsContract = c.router({
  get: {
    method: "GET",
    path: "/api/zero/agents/:id/user-connectors",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: userConnectorEnabledTypesSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get enabled connector types for user on agent",
  },
  update: {
    method: "PUT",
    path: "/api/zero/agents/:id/user-connectors",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    body: userConnectorUpdateSchema,
    responses: {
      200: userConnectorEnabledTypesSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Update enabled connector types for user on agent",
  },
});
export type ZeroUserConnectorsContract = typeof zeroUserConnectorsContract;
