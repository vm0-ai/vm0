import type { Message } from "@earendil-works/pi-ai";
import { z } from "zod";

const textContentSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .passthrough();
const thinkingContentSchema = z
  .object({ type: z.literal("thinking"), thinking: z.string() })
  .passthrough();
const imageContentSchema = z
  .object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string(),
  })
  .passthrough();
const toolCallSchema = z
  .object({
    type: z.literal("toolCall"),
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const usageSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    reasoning: z.number().optional(),
    totalTokens: z.number(),
    cost: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      total: z.number(),
    }),
  })
  .passthrough();

const piMessageSchema: z.ZodType<Message> = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("user"),
      content: z.union([
        z.string(),
        z.array(z.union([textContentSchema, imageContentSchema])),
      ]),
      timestamp: z.number(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.array(
        z.union([textContentSchema, thinkingContentSchema, toolCallSchema]),
      ),
      api: z.string(),
      provider: z.string(),
      model: z.string(),
      usage: usageSchema,
      stopReason: z.enum([
        "pending",
        "stop",
        "length",
        "toolUse",
        "error",
        "aborted",
      ]),
      timestamp: z.number(),
    })
    .passthrough(),
  z
    .object({
      role: z.literal("toolResult"),
      toolCallId: z.string(),
      toolName: z.string(),
      content: z.array(z.union([textContentSchema, imageContentSchema])),
      details: z.unknown().optional(),
      usage: usageSchema.optional(),
      addedToolNames: z.array(z.string()).optional(),
      isError: z.boolean(),
      timestamp: z.number(),
    })
    .passthrough(),
]);

export function isPiAgentMessage(message: unknown): message is Message {
  return piMessageSchema.safeParse(message).success;
}

/** Validate persisted transcript payloads before replaying them into Pi. */
export function parsePiAgentMessages(messages: readonly unknown[]): Message[] {
  return messages.map((message) => {
    return piMessageSchema.parse(message);
  });
}
