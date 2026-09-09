import { z } from "zod";

import { initContract } from "./base";
import { cronCompactChatThreadSnapshotsResponseSchema } from "./cron";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const testChatThreadSnapshotCompactionContract = c.router({
  compact: {
    method: "POST",
    path: "/api/test/compact-chat-thread-snapshots",
    body: z.object({
      scopes: z
        .array(
          z.object({
            user_id: z.string().min(1),
            org_id: z.string().min(1),
          }),
        )
        .min(1)
        .max(100),
    }),
    responses: {
      200: cronCompactChatThreadSnapshotsResponseSchema,
      400: apiErrorSchema,
      404: z.string(),
    },
    summary: "Compact explicitly owned chat thread snapshot test fixtures",
  },
});
