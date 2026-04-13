import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const prepareTriggerBodySchema = z.object({
  agentId: z.string().min(1),
  mode: z.enum(["chat", "meeting"]).default("chat"),
  prompt: z.string().min(1).optional(),
});

const prepareTriggerResponseSchema = z.object({
  preparation: z.object({
    id: z.string(),
    status: z.enum(["preparing", "ready", "failed"]),
    runId: z.string().optional(),
  }),
});

export const zeroVoiceChatPrepareTriggerContract = c.router({
  trigger: {
    method: "POST",
    path: "/api/zero/voice-chat/prepare",
    headers: authHeadersSchema,
    body: prepareTriggerBodySchema,
    responses: {
      200: prepareTriggerResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Trigger a voice-chat preparation run (with dedup and cache)",
  },
});

const prepareCompleteBodySchema = z.object({
  content: z.string().min(1),
});

const prepareCompleteResponseSchema = z.object({
  id: z.string(),
  status: z.enum(["preparing", "ready", "failed"]),
});

export const zeroVoiceChatPrepareCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/zero/voice-chat/prepare/complete",
    headers: authHeadersSchema,
    body: prepareCompleteBodySchema,
    responses: {
      200: prepareCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Complete a voice-chat preparation run by submitting the directive content",
  },
});

export type ZeroVoiceChatPrepareCompleteContract =
  typeof zeroVoiceChatPrepareCompleteContract;
export type PrepareCompleteBody = z.infer<typeof prepareCompleteBodySchema>;
export type PrepareCompleteResponse = z.infer<
  typeof prepareCompleteResponseSchema
>;
