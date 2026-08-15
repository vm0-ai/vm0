import { z } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const ACCOUNT_SUBDOMAIN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

export async function refreshNetSuiteAccessToken(
  args: {
    readonly accountSubdomain: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
) {
  if (!ACCOUNT_SUBDOMAIN.test(args.accountSubdomain)) {
    throw new Error("Invalid NetSuite account domain prefix");
  }
  const tokenUrl = `https://${args.accountSubdomain.toLowerCase()}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
    }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `NetSuite access token refresh failed: ${response.status}`,
      response.status,
    );
  }
  const parsed = z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1).optional(),
      expires_in: z.number().positive().optional(),
    })
    .safeParse(await response.json());
  if (!parsed.success) {
    throw new ProviderResponseError("Invalid NetSuite token response");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresIn: parsed.data.expires_in,
  };
}
