import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testOAuthProviderTokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export const testOAuthProviderTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  scope: z.string(),
});

export const testOAuthProviderTokenContract = c.router({
  token: {
    method: "POST",
    path: "/api/test/oauth-provider/token",
    body: c.type<string>(),
    responses: {
      200: testOAuthProviderTokenResponseSchema,
      400: testOAuthProviderTokenErrorSchema,
      401: testOAuthProviderTokenErrorSchema,
      404: z.string(),
    },
    summary: "Synthetic OAuth token endpoint for test connector flows",
  },
});

export type TestOAuthProviderTokenContract =
  typeof testOAuthProviderTokenContract;
export type TestOAuthProviderTokenResponse = z.infer<
  typeof testOAuthProviderTokenResponseSchema
>;
