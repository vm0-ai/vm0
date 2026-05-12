import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const jsonErrorSchema = z.object({ error: z.string() });

export const zeroSlackOauthInstallQuerySchema = z.object({
  orgId: z.string().optional(),
  vm0UserId: z.string().optional(),
  reinstall: z.string().optional(),
  prompt: z.string().optional(),
});

export const zeroSlackOauthConnectQuerySchema = z.object({
  orgId: z.string().optional(),
  vm0UserId: z.string().optional(),
  prompt: z.string().optional(),
});

export const zeroSlackOauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  state: z.string().optional(),
});

export const zeroSlackOauthContract = c.router({
  install: {
    method: "GET",
    path: "/api/zero/slack/oauth/install",
    query: zeroSlackOauthInstallQuerySchema,
    responses: {
      307: c.noBody(),
      503: jsonErrorSchema,
    },
    summary: "Start Slack bot OAuth install",
  },
  connect: {
    method: "GET",
    path: "/api/zero/slack/oauth/connect",
    query: zeroSlackOauthConnectQuerySchema,
    responses: {
      307: c.noBody(),
      400: jsonErrorSchema,
      404: jsonErrorSchema,
      503: jsonErrorSchema,
    },
    summary: "Start Slack user OAuth connect",
  },
  callback: {
    method: "GET",
    path: "/api/zero/slack/oauth/callback",
    query: zeroSlackOauthCallbackQuerySchema,
    responses: {
      307: c.noBody(),
      400: jsonErrorSchema,
      503: jsonErrorSchema,
    },
    summary: "Handle Slack OAuth callback",
  },
});

export type ZeroSlackOauthContract = typeof zeroSlackOauthContract;
export type ZeroSlackOauthInstallQuery = z.infer<
  typeof zeroSlackOauthInstallQuerySchema
>;
export type ZeroSlackOauthConnectQuery = z.infer<
  typeof zeroSlackOauthConnectQuerySchema
>;
export type ZeroSlackOauthCallbackQuery = z.infer<
  typeof zeroSlackOauthCallbackQuerySchema
>;
