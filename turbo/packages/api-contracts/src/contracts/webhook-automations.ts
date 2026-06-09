import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Webhook-automation management API. Creates/lists/deletes the events-first
 * webhook automations that live on the new `automations` + `automation_triggers`
 * tables (NOT `zero_agent_schedules`). Gated behind the `zeroAutomations`
 * feature switch — when off, these endpoints are not mounted (404), matching the
 * time-automation surface.
 *
 * A webhook automation pairs a user `instruction` with an agent and a linked
 * chat thread. Creation mints an unguessable URL token plus an HMAC signing
 * secret; an external signed POST to the inbound route then fires the automation
 * as an agent run.
 */

/**
 * Webhook-automation projection returned by list/create — the durable view of an
 * `automations` row plus its webhook trigger token. The HMAC `secret` is NEVER
 * part of this shape: it is returned once at creation and never again.
 */
export const webhookAutomationResponseSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  userId: z.string(),
  name: z.string(),
  instruction: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  chatThreadId: z.string().uuid(),
  // Unguessable URL token identifying the inbound trigger. Identity only; the
  // signing secret is separate and shown once at creation.
  webhookToken: z.string(),
  // Full inbound URL the caller POSTs signed payloads to.
  webhookUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const webhookAutomationListResponseSchema = z.object({
  automations: z.array(webhookAutomationResponseSchema),
});

/**
 * Create response — the durable projection plus the HMAC `secret`, surfaced
 * exactly once here. The secret is the only field absent from the list/get
 * projection; callers must persist it on receipt because it is unrecoverable.
 */
export const webhookAutomationCreateResponseSchema = z.object({
  automation: webhookAutomationResponseSchema,
  secret: z.string(),
});

const createWebhookAutomationRequestSchema = z.object({
  name: z.string().min(1).max(64, "Automation name max 64 chars"),
  instruction: z.string().min(1, "Instruction required"),
  description: z.string().optional(),
  agentId: z.string().uuid("Invalid agent ID"),
  enabled: z.boolean().optional(),
  // Chat-thread linkage, honored only on creation. When provided, links the
  // automation to an existing owned chat thread; when omitted, the server
  // creates a web chat thread and links it.
  chatThreadId: z.string().uuid("Invalid chat thread ID").optional(),
});

/**
 * Webhook-automation collection contract (GET/POST /api/automations/webhooks).
 */
export const webhookAutomationsMainContract = c.router({
  create: {
    method: "POST",
    path: "/api/automations/webhooks",
    headers: authHeadersSchema,
    body: createWebhookAutomationRequestSchema,
    responses: {
      201: webhookAutomationCreateResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Create a webhook automation",
  },
  list: {
    method: "GET",
    path: "/api/automations/webhooks",
    headers: authHeadersSchema,
    responses: {
      200: webhookAutomationListResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "List webhook automations",
  },
});

/**
 * Webhook-automation by-id contract (DELETE /api/automations/webhooks/:id).
 * Deleting the automation cascades its trigger row (FK ON DELETE CASCADE).
 */
export const webhookAutomationsByIdContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/automations/webhooks/:id",
    headers: authHeadersSchema,
    pathParams: z.object({
      id: z.string().uuid("Invalid automation ID"),
    }),
    responses: {
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Delete a webhook automation",
  },
});

export type WebhookAutomationsMainContract =
  typeof webhookAutomationsMainContract;
export type WebhookAutomationsByIdContract =
  typeof webhookAutomationsByIdContract;

export type WebhookAutomationResponse = z.infer<
  typeof webhookAutomationResponseSchema
>;
export type WebhookAutomationListResponse = z.infer<
  typeof webhookAutomationListResponseSchema
>;
export type WebhookAutomationCreateResponse = z.infer<
  typeof webhookAutomationCreateResponseSchema
>;
