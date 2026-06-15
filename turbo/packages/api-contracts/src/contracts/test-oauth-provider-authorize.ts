import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testOAuthProviderAuthorizeErrorSchema = z.object({
  error: z.string(),
});

export const testOAuthProviderAuthorizeQuerySchema = z.object({
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  response_type: z.string().optional(),
  scenario: z.string().optional(),
  scope: z.string().optional(),
  state: z.string().optional(),
});

export const testOAuthProviderAuthorizeContract = c.router({
  authorize: {
    method: "GET",
    path: "/api/test/oauth-provider/authorize",
    query: testOAuthProviderAuthorizeQuerySchema,
    responses: {
      302: c.noBody(),
      400: testOAuthProviderAuthorizeErrorSchema,
      404: z.string(),
    },
    summary: "Synthetic OAuth authorize endpoint for test connector flows",
  },
});

export type TestOAuthProviderAuthorizeContract =
  typeof testOAuthProviderAuthorizeContract;
export type TestOAuthProviderAuthorizeQuery = z.infer<
  typeof testOAuthProviderAuthorizeQuerySchema
>;
