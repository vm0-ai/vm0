import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const fixtureKindSchema = z.enum([
  "active-run",
  "failed-message",
  "orphan",
  "queued-message",
  "revoked-message",
]);

export const testCronMonitorChatMessageQueueStateActionBodySchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("seed-fixture"),
      fixture_kind: fixtureKindSchema,
    }),
    z.object({
      action: z.literal("delete-fixture"),
      compose_id: z.string().uuid(),
    }),
  ]);

export const testCronMonitorChatMessageQueueStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

export const testCronMonitorChatMessageQueueStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/cron-monitor-chat-message-queue-state/action",
    body: testCronMonitorChatMessageQueueStateActionBodySchema,
    responses: {
      200: testCronMonitorChatMessageQueueStateActionResponseSchema,
      404: z.string(),
    },
    summary: "Mutate orphaned queued chat message monitor test state",
  },
});

export type TestCronMonitorChatMessageQueueStateActionBody = z.infer<
  typeof testCronMonitorChatMessageQueueStateActionBodySchema
>;
export type TestCronMonitorChatMessageQueueStateActionResponse = z.infer<
  typeof testCronMonitorChatMessageQueueStateActionResponseSchema
>;
export type TestCronMonitorChatMessageQueueStateContract =
  typeof testCronMonitorChatMessageQueueStateContract;
