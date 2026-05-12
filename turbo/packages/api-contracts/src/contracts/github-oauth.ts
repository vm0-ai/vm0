import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

const jsonErrorSchema = z.object({ error: z.string() });

export const githubOauthInstallQuerySchema = z.object({
  vm0UserId: z.string().optional(),
  composeId: z.string().optional(),
});

export const githubOauthCallbackQuerySchema = z.object({
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
  callback: {
    method: "GET",
    path: "/api/github/oauth/callback",
    query: githubOauthCallbackQuerySchema,
    responses: {
      307: c.noBody(),
    },
    summary: "Handle GitHub App OAuth callback",
  },
});

export type GithubOauthContract = typeof githubOauthContract;
export type GithubOauthInstallQuery = z.infer<
  typeof githubOauthInstallQuerySchema
>;
export type GithubOauthCallbackQuery = z.infer<
  typeof githubOauthCallbackQuerySchema
>;
