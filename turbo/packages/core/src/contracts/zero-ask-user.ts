import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const askUserQuestionItemSchema = z.object({
  question: z.string().min(1),
  header: z.string().max(12).optional(),
  options: z
    .array(
      z.object({
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .min(1),
  multiSelect: z.boolean().optional(),
});

export type AskUserQuestionItem = z.infer<typeof askUserQuestionItemSchema>;

const askUserQuestionBodySchema = z.object({
  questions: z.array(askUserQuestionItemSchema).min(1),
});

export type AskUserQuestionBody = z.infer<typeof askUserQuestionBodySchema>;

const askUserQuestionResponseSchema = z.object({
  pendingId: z.string().uuid(),
});

export type AskUserQuestionResponse = z.infer<
  typeof askUserQuestionResponseSchema
>;

export const askUserAnswerStatusSchema = z.enum([
  "pending",
  "answered",
  "expired",
]);

export type AskUserAnswerStatus = z.infer<typeof askUserAnswerStatusSchema>;

const askUserAnswerResponseSchema = z.object({
  status: askUserAnswerStatusSchema,
  answer: z.string().optional(),
});

export type AskUserAnswerResponse = z.infer<typeof askUserAnswerResponseSchema>;

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export const zeroAskUserQuestionContract = c.router({
  postQuestion: {
    method: "POST",
    path: "/api/zero/ask-user/question",
    headers: authHeadersSchema,
    body: askUserQuestionBodySchema,
    responses: {
      200: askUserQuestionResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
    },
    summary:
      "Submit a question for the user and receive a pending ID for polling",
  },
});

export type ZeroAskUserQuestionContract = typeof zeroAskUserQuestionContract;

export const zeroAskUserAnswerContract = c.router({
  getAnswer: {
    method: "GET",
    path: "/api/zero/ask-user/answer",
    headers: authHeadersSchema,
    query: z.object({
      pendingId: z.string().uuid(),
    }),
    responses: {
      200: askUserAnswerResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Poll for the user's answer to a pending question",
  },
});

export type ZeroAskUserAnswerContract = typeof zeroAskUserAnswerContract;
