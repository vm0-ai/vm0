import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testOAuthProviderEchoErrorSchema = z.object({
  error: z.string(),
});

export const testOAuthProviderEchoResponseSchema = z.object({
  authorization: z.string(),
  receivedAt: z.string(),
});

export const testOAuthProviderEchoContract = c.router({
  echo: {
    method: "GET",
    path: "/api/test/oauth-provider/echo",
    responses: {
      200: testOAuthProviderEchoResponseSchema,
      401: testOAuthProviderEchoErrorSchema,
      404: z.string(),
    },
    summary: "Synthetic protected upstream endpoint for test connector flows",
  },
});

export type TestOAuthProviderEchoContract =
  typeof testOAuthProviderEchoContract;
export type TestOAuthProviderEchoResponse = z.infer<
  typeof testOAuthProviderEchoResponseSchema
>;
