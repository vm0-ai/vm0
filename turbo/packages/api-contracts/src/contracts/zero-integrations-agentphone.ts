import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const agentPhoneConnectBodySchema = z.object({
  phoneHandle: z.string().min(1),
  agentphoneAgentId: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
});

const agentPhoneConnectResponseSchema = z.object({
  phoneHandle: z.string(),
});

export const zeroIntegrationsAgentPhoneContract = c.router({
  connectAgentPhone: {
    method: "POST",
    path: "/api/agentphone/connect",
    headers: authHeadersSchema,
    body: agentPhoneConnectBodySchema,
    responses: {
      200: agentPhoneConnectResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Link the authenticated VM0 user to an AgentPhone phone handle",
  },
});

export type ZeroIntegrationsAgentPhoneContract =
  typeof zeroIntegrationsAgentPhoneContract;
export type AgentPhoneConnectResponse = z.infer<
  typeof agentPhoneConnectResponseSchema
>;
