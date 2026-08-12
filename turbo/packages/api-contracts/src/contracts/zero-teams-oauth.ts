import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const jsonErrorSchema = z.object({ error: z.string() });

export const zeroTeamsOauthConnectQuerySchema = z.object({
  orgId: z.string().optional(),
  vm0UserId: z.string().optional(),
  prompt: z.string().optional(),
});

export const zeroTeamsOauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  state: z.string().optional(),
});

export const zeroTeamsOauthContract = c.router({
  connect: {
    method: "GET",
    path: "/api/okou/teams/oauth/connect",
    query: zeroTeamsOauthConnectQuerySchema,
    responses: {
      307: c.noBody(),
      400: jsonErrorSchema,
      503: jsonErrorSchema,
    },
    summary: "Start Microsoft Teams user OAuth connect",
  },
  callback: {
    method: "GET",
    path: "/api/okou/teams/oauth/callback",
    query: zeroTeamsOauthCallbackQuerySchema,
    responses: {
      307: c.noBody(),
      400: jsonErrorSchema,
      503: jsonErrorSchema,
    },
    summary: "Handle Microsoft Teams OAuth callback",
  },
});

export type ZeroTeamsOauthContract = typeof zeroTeamsOauthContract;
export type ZeroTeamsOauthConnectQuery = z.infer<
  typeof zeroTeamsOauthConnectQuerySchema
>;
export type ZeroTeamsOauthCallbackQuery = z.infer<
  typeof zeroTeamsOauthCallbackQuerySchema
>;
