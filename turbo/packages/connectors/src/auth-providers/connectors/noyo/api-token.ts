import { z } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const TOKEN_URL = "https://accounts.noyo.com/auth/public/token";

const noyoAccessTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

export async function fetchNoyoAccessToken(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
  },
  signal: AbortSignal,
): Promise<{ readonly accessToken: string; readonly expiresIn: number }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grant_type: "client_credentials" }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Noyo access token request failed: ${response.status}`,
      response.status,
    );
  }
  const parsed = noyoAccessTokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ProviderResponseError("Invalid Noyo access token response");
  }
  return {
    accessToken: parsed.data.access_token,
    // Noyo reports milliseconds; connector providers expose expiry in seconds.
    expiresIn: parsed.data.expires_in / 1000,
  };
}
