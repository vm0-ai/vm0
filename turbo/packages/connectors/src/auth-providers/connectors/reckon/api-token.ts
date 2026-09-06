import { z } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const RECKON_TOKEN_URL = "https://identity.reckon.com/connect/token";

interface ReckonTokenResult {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn?: number;
}

export async function refreshReckonAccessToken(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly refreshToken: string;
  },
  signal: AbortSignal,
): Promise<ReckonTokenResult> {
  const response = await fetch(RECKON_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      redirect_uri: args.redirectUri,
    }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Reckon access token refresh failed: ${response.status}`,
      response.status,
    );
  }

  const parsed = z
    .object({
      access_token: z.string().min(1).optional(),
      refresh_token: z.string().min(1).optional(),
      expires_in: z.number().positive().optional(),
      error: z.string().min(1).optional(),
      error_description: z.string().min(1).optional(),
    })
    .safeParse(await response.json());
  if (!parsed.success) {
    throw new ProviderResponseError("Invalid Reckon token response");
  }
  if (parsed.data.error !== undefined) {
    throw new ProviderResponseError(
      parsed.data.error_description ?? parsed.data.error,
    );
  }
  if (parsed.data.access_token === undefined) {
    throw new ProviderResponseError("No access token in Reckon token response");
  }
  return {
    accessToken: parsed.data.access_token,
    ...(parsed.data.refresh_token === undefined
      ? {}
      : { refreshToken: parsed.data.refresh_token }),
    ...(parsed.data.expires_in === undefined
      ? {}
      : { expiresIn: parsed.data.expires_in }),
  };
}
