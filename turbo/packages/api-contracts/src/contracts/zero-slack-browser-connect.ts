import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const zeroSlackBrowserConnectQuerySchema = z.object({
  w: z.string().optional(),
  u: z.string().optional(),
  c: z.string().optional(),
  t: z.string().optional(),
  orgId: z.string().optional(),
});

export const zeroSlackBrowserConnectContract = c.router({
  connect: {
    method: "GET",
    path: "/api/zero/slack/connect",
    query: zeroSlackBrowserConnectQuerySchema,
    responses: {
      307: c.noBody(),
      500: z.object({ error: z.string() }),
    },
    summary: "Browser Slack connect flow",
  },
});

export type ZeroSlackBrowserConnectContract =
  typeof zeroSlackBrowserConnectContract;
export type ZeroSlackBrowserConnectQuery = z.infer<
  typeof zeroSlackBrowserConnectQuerySchema
>;
