import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const zeroFeishuBrowserConnectContract = c.router({
  connect: {
    method: "GET",
    path: "/api/zero/feishu/connect",
    query: z.object({
      tenantKey: z.string().optional(),
      openId: z.string().optional(),
      chatId: z.string().optional(),
      ts: z.coerce.number().int().optional(),
      sig: z.string().optional(),
    }),
    responses: {
      307: c.noBody(),
      500: z.object({ error: z.string() }),
    },
    summary: "Connect a Feishu user from a direct message",
  },
});

export type ZeroFeishuBrowserConnectContract =
  typeof zeroFeishuBrowserConnectContract;
