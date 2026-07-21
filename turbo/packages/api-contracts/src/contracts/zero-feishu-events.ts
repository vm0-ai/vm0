import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const zeroFeishuEventsContract = c.router({
  post: {
    method: "POST",
    path: "/api/zero/feishu/events",
    body: c.type<string>(),
    responses: {
      200: z.unknown(),
      400: z.object({ error: z.string() }),
      401: z.object({ error: z.string() }),
      503: z.object({ error: z.string() }),
    },
    summary: "Handle Feishu event callbacks",
  },
});

export type ZeroFeishuEventsContract = typeof zeroFeishuEventsContract;
