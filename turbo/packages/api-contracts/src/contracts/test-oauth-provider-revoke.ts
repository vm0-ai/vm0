import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testOAuthProviderRevokeErrorSchema = z.object({
  error: z.string(),
});

export const testOAuthProviderRevokeResponseSchema = z.object({
  revoked: z.literal(true),
});

export const testOAuthProviderRevokeContract = c.router({
  revoke: {
    method: "POST",
    path: "/api/test/oauth-provider/revoke",
    body: c.type<string>(),
    responses: {
      200: testOAuthProviderRevokeResponseSchema,
      400: testOAuthProviderRevokeErrorSchema,
      401: testOAuthProviderRevokeErrorSchema,
      404: z.string(),
    },
    summary: "Synthetic OAuth token revocation endpoint for test flows",
  },
});

export type TestOAuthProviderRevokeContract =
  typeof testOAuthProviderRevokeContract;
