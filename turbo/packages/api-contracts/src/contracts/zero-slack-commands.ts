import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const zeroSlackCommandsContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/slack/commands",
    body: c.type<string>(),
    responses: {
      200: z.unknown(),
      401: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
    summary: "Handle Zero Slack slash commands",
  },
});

export type ZeroSlackCommandsContract = typeof zeroSlackCommandsContract;
