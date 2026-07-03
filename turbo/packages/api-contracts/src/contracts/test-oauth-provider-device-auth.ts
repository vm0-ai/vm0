import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testOAuthProviderDeviceAuthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export const testOAuthProviderDeviceAuthResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string(),
  expires_in: z.number(),
  interval: z.number(),
});

export const testOAuthProviderDeviceAuthContract = c.router({
  deviceAuth: {
    method: "POST",
    path: "/api/test/oauth-provider/device/code",
    body: c.type<string>(),
    responses: {
      200: testOAuthProviderDeviceAuthResponseSchema,
      400: testOAuthProviderDeviceAuthErrorSchema,
      401: testOAuthProviderDeviceAuthErrorSchema,
      404: z.string(),
    },
    summary:
      "Synthetic OAuth device authorization endpoint for test connector flows",
  },
});

export type TestOAuthProviderDeviceAuthContract =
  typeof testOAuthProviderDeviceAuthContract;
export type TestOAuthProviderDeviceAuthResponse = z.infer<
  typeof testOAuthProviderDeviceAuthResponseSchema
>;
