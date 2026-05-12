import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testOAuthProviderUserinfoErrorSchema = z.object({
  error: z.string(),
});

export const testOAuthProviderUserinfoResponseSchema = z.object({
  email: z.string(),
  id: z.string(),
  username: z.string(),
});

export const testOAuthProviderUserinfoContract = c.router({
  userinfo: {
    method: "GET",
    path: "/api/test/oauth-provider/userinfo",
    responses: {
      200: testOAuthProviderUserinfoResponseSchema,
      401: testOAuthProviderUserinfoErrorSchema,
      404: z.string(),
    },
    summary: "Synthetic OAuth userinfo endpoint for test connector flows",
  },
});

export type TestOAuthProviderUserinfoContract =
  typeof testOAuthProviderUserinfoContract;
export type TestOAuthProviderUserinfoResponse = z.infer<
  typeof testOAuthProviderUserinfoResponseSchema
>;
