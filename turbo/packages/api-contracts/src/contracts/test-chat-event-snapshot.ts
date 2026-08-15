import { z } from "zod";

import { initContract } from "./base";
import { cronSnapshotChatEventsResponseSchema } from "./cron";

const c = initContract();

export const testChatEventSnapshotBodySchema = z.object({
  chat_thread_ids: z.array(z.uuid()).max(100),
  r2_object_keys: z.array(z.string().min(1)).max(2000),
});

export const testChatEventSnapshotContract = c.router({
  snapshot: {
    method: "POST",
    path: "/api/test/snapshot-chat-events",
    body: testChatEventSnapshotBodySchema,
    responses: {
      200: cronSnapshotChatEventsResponseSchema,
      404: z.string(),
    },
    summary: "Snapshot explicitly owned chat event test fixtures",
  },
});

export type TestChatEventSnapshotContract =
  typeof testChatEventSnapshotContract;
