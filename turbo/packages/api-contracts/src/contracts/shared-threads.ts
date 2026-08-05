import { z } from "zod";

import { apiErrorSchema } from "./errors";
import { authHeadersSchema, initContract } from "./base";

const c = initContract();

export const sharedMessageSchema = z
  .object({
    messageIndex: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    runIndex: z.number().int().nonnegative().optional(),
    runGroupIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

const sharedThreadIdPathParamsSchema = z.object({
  id: z.string().uuid(),
});

const createSharedThreadBodySchema = z.object({
  eventIds: z.array(z.string().uuid()).min(1),
});

const createSharedThreadResponseSchema = z.object({
  id: z.string().uuid(),
});

const sharedThreadResponseSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  messages: z.array(sharedMessageSchema),
});

const sharedThreadMetaResponseSchema = z.object({
  title: z.string(),
});

export const sharedThreadsContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/chat-threads/:threadId/shared-threads",
    headers: authHeadersSchema,
    pathParams: z.object({ threadId: z.string().uuid() }),
    body: createSharedThreadBodySchema,
    responses: {
      201: createSharedThreadResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
    },
    summary: "Create an immutable public snapshot from selected chat events",
  },
  get: {
    method: "GET",
    path: "/api/zero/shared-threads/:id",
    pathParams: sharedThreadIdPathParamsSchema,
    responses: {
      200: sharedThreadResponseSchema,
      404: apiErrorSchema,
    },
    summary: "Read an immutable public chat snapshot",
  },
  meta: {
    method: "GET",
    path: "/api/zero/shared-threads/:id/meta",
    pathParams: sharedThreadIdPathParamsSchema,
    responses: {
      200: sharedThreadMetaResponseSchema,
      404: apiErrorSchema,
    },
    summary: "Read public metadata for a shared chat snapshot",
  },
});

export type SharedThreadsContract = typeof sharedThreadsContract;
export type SharedMessage = z.infer<typeof sharedMessageSchema>;
export type SharedThreadResponse = z.infer<typeof sharedThreadResponseSchema>;
