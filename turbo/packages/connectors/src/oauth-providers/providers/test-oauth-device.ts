import { getConnectorOAuthDeviceAuthConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";

import type {
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthStartResult,
} from "../provider-types";
import { throwOAuthError } from "./oauth-error";
import {
  resolveTestOAuthProviderUrl,
  testOAuthPreviewBypassHeaders,
} from "./test-oauth";

export const TEST_OAUTH_DEVICE_CLIENT_ID = "test-oauth-device-client";
export const TEST_OAUTH_DEVICE_USER_CODE = "TEST-DEVICE";
export const TEST_OAUTH_DEVICE_VERIFICATION_URI =
  "https://oauth-device.test/device";
export const TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME =
  "TEST_OAUTH_DEVICE_ACCESS_TOKEN";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const deviceAuthResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number().optional(),
});

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

const tokenErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

function getDeviceAuthUrl(): string {
  return resolveTestOAuthProviderUrl(
    "deviceAuthUrl",
    getConnectorOAuthDeviceAuthConfig("test-oauth-device").deviceAuthUrl,
  );
}

function getDeviceTokenUrl(): string {
  return resolveTestOAuthProviderUrl(
    "tokenUrl",
    getConnectorOAuthDeviceAuthConfig("test-oauth-device").tokenUrl,
  );
}

export async function startTestOAuthDeviceAuth(args: {
  readonly clientId: string;
  readonly scopes: readonly string[];
}): Promise<OAuthDeviceAuthStartResult> {
  const response = await fetch(getDeviceAuthUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...testOAuthPreviewBypassHeaders(),
    },
    body: new URLSearchParams({
      client_id: args.clientId,
      scope: args.scopes.join(" "),
    }),
  });

  if (!response.ok) {
    await throwOAuthError("TestOAuthDevice", "start", response);
  }

  const data = deviceAuthResponseSchema.parse(await response.json());
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresIn: data.expires_in,
    interval: data.interval,
  };
}

function devicePollErrorResult(args: {
  readonly error: string;
  readonly errorDescription: string | undefined;
}): OAuthDeviceAuthPollResult | null {
  if (args.error === "authorization_pending") {
    return { status: "pending" };
  }
  if (args.error === "slow_down") {
    return { status: "slow_down" };
  }
  if (args.error === "access_denied") {
    return {
      status: "denied",
      error: args.error,
      errorDescription: args.errorDescription,
    };
  }
  if (args.error === "expired_token") {
    return {
      status: "expired",
      error: args.error,
      errorDescription: args.errorDescription,
    };
  }
  if (args.error === "invalid_request" || args.error === "invalid_grant") {
    return {
      status: "error",
      error: args.error,
      errorDescription: args.errorDescription,
    };
  }
  return null;
}

export async function pollTestOAuthDeviceAuth(args: {
  readonly clientId: string;
  readonly deviceCode: string;
}): Promise<OAuthDeviceAuthPollResult> {
  const response = await fetch(getDeviceTokenUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...testOAuthPreviewBypassHeaders(),
    },
    body: new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      client_id: args.clientId,
      device_code: args.deviceCode,
    }),
  });

  if (!response.ok) {
    const diagnosticResponse = response.clone();
    const errorParse = tokenErrorResponseSchema.safeParse(
      await response.json().catch(() => {
        return null;
      }),
    );
    if (!errorParse.success) {
      return await throwOAuthError(
        "TestOAuthDevice",
        "poll",
        diagnosticResponse,
      );
    }
    const errorData = errorParse.data;
    const result = devicePollErrorResult({
      error: errorData.error,
      errorDescription: errorData.error_description,
    });
    if (result) {
      return result;
    }
    await throwOAuthError("TestOAuthDevice", "poll", diagnosticResponse);
  }

  const data = tokenResponseSchema.parse(await response.json());
  return {
    status: "complete",
    token: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresIn: data.expires_in,
      scopes: data.scope?.split(" ") ?? [],
      userInfo: {
        id: "test-oauth-device-user",
        username: "test-oauth-device-user",
        email: "test-oauth-device@example.com",
      },
    },
  };
}
