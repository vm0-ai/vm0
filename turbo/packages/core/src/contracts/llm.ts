import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Message role for chat completion
 */
export const messageRoleSchema = z.enum(["user", "assistant", "system"]);

/**
 * Chat message schema
 */
export const chatMessageSchema = z.object({
  role: messageRoleSchema,
  content: z.string(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * Token usage schema
 */
export const tokenUsageSchema = z.object({
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
});

export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/**
 * LLM chat request schema
 */
export const llmChatRequestSchema = z.object({
  model: z.string().min(1, "Model is required"),
  messages: z
    .array(chatMessageSchema)
    .min(1, "At least one message is required"),
  stream: z.boolean().optional().default(false),
});

export type LlmChatRequest = z.infer<typeof llmChatRequestSchema>;

/**
 * LLM chat response schema (non-streaming)
 */
export const llmChatResponseSchema = z.object({
  content: z.string(),
  model: z.string(),
  usage: tokenUsageSchema,
});

export type LlmChatResponse = z.infer<typeof llmChatResponseSchema>;

/**
 * Headers schema for LLM endpoints
 * Requires x-openrouter-token for authentication
 */
export const llmHeadersSchema = z.object({
  "x-openrouter-token": z.string().optional(),
});

/**
 * LLM chat contract for /api/llm/chat
 */
export const llmChatContract = c.router({
  chat: {
    method: "POST",
    path: "/api/llm/chat",
    headers: llmHeadersSchema,
    body: llmChatRequestSchema,
    responses: {
      200: llmChatResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Send a chat completion request to OpenRouter",
  },
});

export type LlmChatContract = typeof llmChatContract;
