import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const agentPhoneConnectBodySchema = z.object({
  phoneHandle: z.string().min(1),
  agentphoneAgentId: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
  channel: z.string().min(1).optional(),
});

const agentPhoneConnectResponseSchema = z.object({
  phoneHandle: z.string(),
});

const agentPhoneLinkStatusResponseSchema = z.discriminatedUnion("linked", [
  z.object({
    linked: z.literal(true),
    phoneHandle: z.string(),
    agentPhoneNumber: z.string().nullable(),
    configured: z.boolean(),
  }),
  z.object({
    linked: z.literal(false),
    agentPhoneNumber: z.string().nullable(),
    configured: z.boolean(),
  }),
]);

const agentPhoneStartLinkBodySchema = z.object({
  phoneHandle: z.string().min(1),
});

const agentPhoneStartLinkResponseSchema = z.object({
  phoneHandle: z.string(),
  verificationSent: z.literal(true),
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
  getLinkStatus: {
    method: "GET",
    path: "/api/integrations/agentphone/link",
    headers: authHeadersSchema,
    responses: {
      200: agentPhoneLinkStatusResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Check the authenticated user's AgentPhone link status",
  },
  startLink: {
    method: "POST",
    path: "/api/integrations/agentphone/link",
    headers: authHeadersSchema,
    body: agentPhoneStartLinkBodySchema,
    responses: {
      200: agentPhoneStartLinkResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      429: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Send a verified AgentPhone connection link by SMS",
  },
  unlink: {
    method: "DELETE",
    path: "/api/integrations/agentphone/link",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect the authenticated user's AgentPhone link",
  },
});

export type ZeroIntegrationsAgentPhoneContract =
  typeof zeroIntegrationsAgentPhoneContract;
export type AgentPhoneConnectResponse = z.infer<
  typeof agentPhoneConnectResponseSchema
>;
export type AgentPhoneLinkStatusResponse = z.infer<
  typeof agentPhoneLinkStatusResponseSchema
>;
export type AgentPhoneStartLinkResponse = z.infer<
  typeof agentPhoneStartLinkResponseSchema
>;
