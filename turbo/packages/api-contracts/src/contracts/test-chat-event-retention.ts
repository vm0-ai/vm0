import { z } from "zod";

import { initContract } from "./base";
import { cronRetainChatEventsResponseSchema } from "./cron";

const c = initContract();

export const testChatEventRetentionContract = c.router({
  retain: {
    method: "POST",
    path: "/api/test/retain-chat-events",
    body: z.object({
      chat_thread_ids: z.array(z.uuid()).min(1).max(100),
    }),
    responses: {
      200: cronRetainChatEventsResponseSchema,
      404: z.string(),
    },
    summary: "Retain explicitly owned chat event test fixtures",
  },
  sessionPrompt: {
    method: "POST",
    path: "/api/test/chat-event-session-prompt",
    body: z.object({
      chat_thread_id: z.uuid(),
    }),
    responses: {
      200: z.object({ prompt: z.string() }),
      404: z.string(),
    },
    summary: "Resolve a rotated web chat session prompt for test fixtures",
  },
});

export type TestChatEventRetentionContract =
  typeof testChatEventRetentionContract;
