import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const strapiIntegrationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  baseUrl: z.url(),
  webhookUrl: z.url(),
  secretLastFour: z.string().length(4),
  lastTestedAt: z.string().datetime().nullable(),
  lastReceivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type StrapiIntegration = z.infer<typeof strapiIntegrationSchema>;

export const strapiIntegrationSecretSchema = z.object({
  webhookUrl: z.url(),
  authorizationHeader: z.string().startsWith("Bearer "),
});
export type StrapiIntegrationSecret = z.infer<
  typeof strapiIntegrationSecretSchema
>;

const integrationIdParams = z.object({ integrationId: z.string().uuid() });

export const zeroStrapiIntegrationsContract = c.router({
  list: {
    method: "GET",
    path: "/api/zero/integrations/strapi",
    headers: authHeadersSchema,
    responses: {
      200: z.array(strapiIntegrationSchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List Strapi integrations",
  },
  create: {
    method: "POST",
    path: "/api/zero/integrations/strapi",
    headers: authHeadersSchema,
    body: z.object({
      name: z.string().trim().min(1).max(128),
      baseUrl: z.url(),
    }),
    responses: {
      201: strapiIntegrationSchema.extend({
        authorizationHeader: z.string().startsWith("Bearer "),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Create a Strapi integration",
  },
  revealSecret: {
    method: "POST",
    path: "/api/zero/integrations/strapi/:integrationId/secret",
    headers: authHeadersSchema,
    pathParams: integrationIdParams,
    body: c.noBody(),
    responses: {
      200: strapiIntegrationSecretSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Reveal a Strapi webhook authorization header",
  },
  checkTest: {
    method: "POST",
    path: "/api/zero/integrations/strapi/:integrationId/check-test",
    headers: authHeadersSchema,
    pathParams: integrationIdParams,
    body: c.noBody(),
    responses: {
      200: z.object({
        received: z.boolean(),
        lastTestedAt: z.string().datetime().nullable(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Check whether Strapi sent its test webhook",
  },
  remove: {
    method: "DELETE",
    path: "/api/zero/integrations/strapi/:integrationId",
    headers: authHeadersSchema,
    pathParams: integrationIdParams,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Remove a Strapi integration",
  },
});

export const zeroStrapiEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/strapi/events/:integrationId",
    pathParams: integrationIdParams,
    headers: z.object({
      authorization: z.string().optional(),
      "x-strapi-event": z.string().optional(),
    }),
    body: z.unknown(),
    responses: {
      200: z.object({
        success: z.literal(true),
        kind: z.enum(["test", "publish", "ignored", "duplicate"]),
        queued: z.number().int().nonnegative(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
    },
    summary: "Receive Strapi webhook events",
  },
});

export type ZeroStrapiIntegrationsContract =
  typeof zeroStrapiIntegrationsContract;
export type ZeroStrapiEventsContract = typeof zeroStrapiEventsContract;
