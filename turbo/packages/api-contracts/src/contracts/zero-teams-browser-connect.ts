import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const zeroTeamsBrowserConnectQuerySchema = z.object({
  tenantId: z.string().optional(),
  teamsUserId: z.string().optional(),
  displayName: z.string().optional(),
  upn: z.string().optional(),
  conversationId: z.string().optional(),
  channelId: z.string().optional(),
  threadId: z.string().optional(),
  orgId: z.string().optional(),
});

export const zeroTeamsBrowserConnectContract = c.router({
  connect: {
    method: "GET",
    path: "/api/zero/teams/connect",
    query: zeroTeamsBrowserConnectQuerySchema,
    responses: {
      307: c.noBody(),
      500: z.object({ error: z.string() }),
    },
    summary: "Browser Microsoft Teams connect flow",
  },
});

export type ZeroTeamsBrowserConnectContract =
  typeof zeroTeamsBrowserConnectContract;
export type ZeroTeamsBrowserConnectQuery = z.infer<
  typeof zeroTeamsBrowserConnectQuerySchema
>;
