import { z } from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const jsonErrorSchema = z.object({ error: z.string() });

export const githubOauthInstallQuerySchema = z.object({
  vm0UserId: z.string().optional(),
  orgId: z.string().optional(),
  composeId: z.string().optional(),
});

export const githubOauthConnectQuerySchema = z.object({
  installation: z.string().optional(),
  ghUser: z.string().optional(),
  ghLogin: z.string().optional(),
  ts: z.coerce.number().optional(),
  sig: z.string().optional(),
});

export const githubOauthConnectCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export const githubAppSetupCallbackQuerySchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  installation_id: z.string().optional(),
  setup_action: z.string().optional(),
  state: z.string().optional(),
  target_id: z.string().optional(),
  target_type: z.string().optional(),
});

export const githubOauthContract = c.router({
  install: {
    method: "GET",
    path: "/api/github/oauth/install",
    query: githubOauthInstallQuerySchema,
    responses: {
      307: c.noBody(),
      503: jsonErrorSchema,
    },
    summary: "Start GitHub App OAuth install",
  },
  connect: {
    method: "GET",
    path: "/api/zero/github/oauth/connect",
    query: githubOauthConnectQuerySchema,
    responses: {
      307: c.noBody(),
      401: apiErrorSchema,
      503: jsonErrorSchema,
    },
    summary: "Start GitHub user OAuth for the GitHub integration",
  },
  connectCallback: {
    method: "GET",
    path: "/api/zero/github/oauth/connect/callback",
    query: githubOauthConnectCallbackQuerySchema,
    responses: {
      307: c.noBody(),
    },
    summary: "Handle GitHub user OAuth for the GitHub integration",
  },
  setupCallback: {
    method: "GET",
    path: "/api/github/app/setup/callback",
    query: githubAppSetupCallbackQuerySchema,
    responses: {
      307: c.noBody(),
    },
    summary: "Handle GitHub App setup callback",
  },
});

export type GithubOauthContract = typeof githubOauthContract;
export type GithubOauthInstallQuery = z.infer<
  typeof githubOauthInstallQuerySchema
>;
export type GithubOauthConnectQuery = z.infer<
  typeof githubOauthConnectQuerySchema
>;
export type GithubOauthConnectCallbackQuery = z.infer<
  typeof githubOauthConnectCallbackQuerySchema
>;
export type GithubAppSetupCallbackQuery = z.infer<
  typeof githubAppSetupCallbackQuerySchema
>;
