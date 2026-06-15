import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const zeroSlackInteractiveContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/slack/interactive",
    body: c.type<string>(),
    responses: {
      200: z.unknown(),
      400: z.object({ error: z.string() }),
      401: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
    summary: "Handle Zero Slack interactive component callbacks",
  },
});

export type ZeroSlackInteractiveContract = typeof zeroSlackInteractiveContract;
