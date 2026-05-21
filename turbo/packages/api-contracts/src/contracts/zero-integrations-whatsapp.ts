import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const whatsAppConnectBodySchema = z.object({
  phoneHandle: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
});

const whatsAppConnectResponseSchema = z.object({
  phoneHandle: z.string(),
});

const whatsAppWebhookHeadersSchema = z.object({
  "x-twilio-signature": z.string().optional(),
});

const whatsAppLinkStatusResponseSchema = z.discriminatedUnion("linked", [
  z.object({
    linked: z.literal(true),
    phoneHandle: z.string(),
    whatsAppNumber: z.string().nullable(),
    configured: z.boolean(),
  }),
  z.object({
    linked: z.literal(false),
    whatsAppNumber: z.string().nullable(),
    configured: z.boolean(),
  }),
]);

const whatsAppStartLinkBodySchema = z.object({
  phoneHandle: z.string().min(1),
});

const whatsAppStartLinkResponseSchema = z.object({
  phoneHandle: z.string(),
  verificationSent: z.literal(true),
});

export const zeroIntegrationsWhatsAppContract = c.router({
  connectWhatsApp: {
    method: "POST",
    path: "/api/whatsapp/connect",
    headers: authHeadersSchema,
    body: whatsAppConnectBodySchema,
    responses: {
      200: whatsAppConnectResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Link the authenticated VM0 user to a WhatsApp sender",
  },
  webhook: {
    method: "POST",
    path: "/api/integrations/twilio/webhook",
    headers: whatsAppWebhookHeadersSchema,
    body: c.type<string>(),
    responses: {
      200: z.string(),
      400: z.string(),
      401: z.string(),
      404: z.string(),
    },
    summary: "Handle Twilio WhatsApp inbound message webhooks",
  },
  getLinkStatus: {
    method: "GET",
    path: "/api/integrations/whatsapp/link",
    headers: authHeadersSchema,
    responses: {
      200: whatsAppLinkStatusResponseSchema,
      401: apiErrorSchema,
    },
    summary: "Check the authenticated user's WhatsApp link status",
  },
  startLink: {
    method: "POST",
    path: "/api/integrations/whatsapp/link",
    headers: authHeadersSchema,
    body: whatsAppStartLinkBodySchema,
    responses: {
      200: whatsAppStartLinkResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
      429: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Send a verified WhatsApp connection link through Twilio",
  },
  unlink: {
    method: "DELETE",
    path: "/api/integrations/whatsapp/link",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Disconnect the authenticated user's WhatsApp link",
  },
});

export type ZeroIntegrationsWhatsAppContract =
  typeof zeroIntegrationsWhatsAppContract;
export type WhatsAppConnectResponse = z.infer<
  typeof whatsAppConnectResponseSchema
>;
export type WhatsAppLinkStatusResponse = z.infer<
  typeof whatsAppLinkStatusResponseSchema
>;
export type WhatsAppStartLinkResponse = z.infer<
  typeof whatsAppStartLinkResponseSchema
>;
