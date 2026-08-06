import { z } from "zod";

import { apiErrorSchema, type ApiErrorResponse } from "./errors";
import { authHeadersSchema, initContract } from "./base";
import type { ZodLikeSchema } from "./trpc-contract";

const c = initContract();

export interface SharedMessage {
  readonly messageIndex: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly runIndex?: number;
  readonly runGroupIndex?: number;
}

export interface SharedThreadResponse {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly SharedMessage[];
}

interface CreateSharedThreadResponse {
  readonly id: string;
}

interface SharedThreadMetaResponse {
  readonly title: string;
}

const sharedMessageZodSchema = z
  .object({
    messageIndex: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    runIndex: z.number().int().nonnegative().optional(),
    runGroupIndex: z.number().int().nonnegative().optional(),
  })
  .strict();
export const sharedMessageSchema: ZodLikeSchema<SharedMessage> =
  sharedMessageZodSchema;

const sharedThreadIdPathParamsSchema = z.object({
  id: z.string().uuid(),
});

const createSharedThreadPathParamsSchema = z.object({
  threadId: z.string().uuid(),
});

const createSharedThreadBodySchema = z.object({
  eventIds: z.array(z.string().uuid()).min(1),
});

const createSharedThreadResponseSchema: ZodLikeSchema<CreateSharedThreadResponse> =
  z.object({
    id: z.string().uuid(),
  });

const sharedThreadResponseSchema: ZodLikeSchema<SharedThreadResponse> =
  z.object({
    id: z.string().uuid(),
    title: z.string(),
    messages: z.array(sharedMessageZodSchema),
  });

const sharedThreadMetaResponseSchema: ZodLikeSchema<SharedThreadMetaResponse> =
  z.object({
    title: z.string(),
  });

const sharedThreadApiErrorSchema: ZodLikeSchema<ApiErrorResponse> =
  apiErrorSchema;

export const sharedThreadsContract = c.router({
  create: {
    method: "POST",
    path: "/api/zero/chat-threads/:threadId/shared-threads",
    headers: authHeadersSchema,
    pathParams: createSharedThreadPathParamsSchema,
    body: createSharedThreadBodySchema,
    responses: {
      201: createSharedThreadResponseSchema,
      400: sharedThreadApiErrorSchema,
      401: sharedThreadApiErrorSchema,
      403: sharedThreadApiErrorSchema,
      404: sharedThreadApiErrorSchema,
      413: sharedThreadApiErrorSchema,
    },
    summary: "Create an immutable public snapshot from selected chat events",
  },
  get: {
    method: "GET",
    path: "/api/zero/shared-threads/:id",
    pathParams: sharedThreadIdPathParamsSchema,
    responses: {
      200: sharedThreadResponseSchema,
      404: sharedThreadApiErrorSchema,
    },
    summary: "Read an immutable public chat snapshot",
  },
  meta: {
    method: "GET",
    path: "/api/zero/shared-threads/:id/meta",
    pathParams: sharedThreadIdPathParamsSchema,
    responses: {
      200: sharedThreadMetaResponseSchema,
      404: sharedThreadApiErrorSchema,
    },
    summary: "Read public metadata for a shared chat snapshot",
  },
});

export type SharedThreadsContract = typeof sharedThreadsContract;
