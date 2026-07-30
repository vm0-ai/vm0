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

export const testCronMonitorChatEventQueueStateActionBodySchema =
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

export const testCronMonitorChatEventQueueStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .passthrough();

export const testCronMonitorChatEventQueueStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/cron-monitor-chat-message-queue-state/action",
    body: testCronMonitorChatEventQueueStateActionBodySchema,
    responses: {
      200: testCronMonitorChatEventQueueStateActionResponseSchema,
      404: z.string(),
    },
    summary: "Mutate orphaned queued chat message monitor test state",
  },
});

export type TestCronMonitorChatEventQueueStateActionBody = z.infer<
  typeof testCronMonitorChatEventQueueStateActionBodySchema
>;
export type TestCronMonitorChatEventQueueStateActionResponse = z.infer<
  typeof testCronMonitorChatEventQueueStateActionResponseSchema
>;
export type TestCronMonitorChatEventQueueStateContract =
  typeof testCronMonitorChatEventQueueStateContract;
