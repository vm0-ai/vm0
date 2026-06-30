import { z } from "zod";

import { persistedAttachmentSchema } from "./chat-threads";
import { initContract } from "./base";

const c = initContract();

const nullableDateStringSchema = z.string().nullable();
const optionalDateStringSchema = z.string().optional();

export const testChatThreadStateErrorSchema = z.object({
  error: z.string(),
});

export const testChatThreadStateFixtureSchema = z.object({
  user_id: z.string(),
  org_id: z.string(),
  compose_id: z.string(),
  thread_id: z.string(),
});

const fixtureInputSchema = testChatThreadStateFixtureSchema;

export const testChatThreadStateActionBodySchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("seed-thread"),
      user_id: z.string().optional(),
      org_id: z.string().optional(),
      title: z.string().nullable().optional(),
      pinned_at: nullableDateStringSchema.optional(),
      renamed_at: nullableDateStringSchema.optional(),
      last_read_at: nullableDateStringSchema.optional(),
      last_read_message_id: z.string().nullable().optional(),
      draft_content: z.string().nullable().optional(),
      draft_attachments: z
        .array(persistedAttachmentSchema)
        .nullable()
        .optional(),
      created_at: optionalDateStringSchema,
      agent_avatar_url: z.string().nullable().optional(),
    }),
    z.object({
      action: z.literal("delete-thread"),
      fixture: fixtureInputSchema,
    }),
  ],
);

export const testChatThreadStateActionResponseSchema = z.object({
  ok: z.literal(true),
  fixture: testChatThreadStateFixtureSchema.optional(),
});

export const testChatThreadStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/chat-thread-state/action",
    body: testChatThreadStateActionBodySchema,
    responses: {
      200: testChatThreadStateActionResponseSchema,
      400: testChatThreadStateErrorSchema,
      404: z.string(),
    },
    summary: "Mutate chat thread API test support state",
  },
});

export type TestChatThreadStateContract = typeof testChatThreadStateContract;
export type TestChatThreadStateFixture = z.infer<
  typeof testChatThreadStateFixtureSchema
>;
export type TestChatThreadStateActionBody = z.infer<
  typeof testChatThreadStateActionBodySchema
>;
export type TestChatThreadStateActionResponse = z.infer<
  typeof testChatThreadStateActionResponseSchema
>;
