import { z } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const TOKEN_URL = "https://api.ramp.com/developer/v1/token";

export async function fetchRampAccessToken(
  args: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly scope: string;
  },
  signal: AbortSignal,
) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: args.scope,
    }),
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Ramp access token request failed: ${response.status}`,
      response.status,
    );
  }
  const parsed = z
    .object({
      access_token: z.string().min(1),
      expires_in: z.number().positive(),
    })
    .safeParse(await response.json());
  if (!parsed.success) {
    throw new ProviderResponseError("Invalid Ramp access token response");
  }
  return {
    accessToken: parsed.data.access_token,
    expiresIn: parsed.data.expires_in,
  };
}
