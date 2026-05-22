import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testOAuthProviderDeviceAuthorizationErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export const testOAuthProviderDeviceAuthorizationResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});

export const testOAuthProviderDeviceAuthorizationContract = c.router({
  deviceAuthorization: {
    method: "POST",
    path: "/api/test/oauth-provider/device/code",
    body: c.type<string>(),
    responses: {
      200: testOAuthProviderDeviceAuthorizationResponseSchema,
      400: testOAuthProviderDeviceAuthorizationErrorSchema,
      401: testOAuthProviderDeviceAuthorizationErrorSchema,
      404: z.string(),
    },
    summary:
      "Synthetic OAuth device authorization endpoint for test connector flows",
  },
});

export type TestOAuthProviderDeviceAuthorizationContract =
  typeof testOAuthProviderDeviceAuthorizationContract;
export type TestOAuthProviderDeviceAuthorizationResponse = z.infer<
  typeof testOAuthProviderDeviceAuthorizationResponseSchema
>;
