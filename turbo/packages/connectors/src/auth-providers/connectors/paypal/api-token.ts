import { z } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const TOKEN_URL = "https://api-m.paypal.com/v1/oauth2/token";

export async function fetchPayPalAccessToken(args: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signal: AbortSignal;
}) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    signal: args.signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `PayPal access token request failed: ${response.status}`,
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
    throw new ProviderResponseError("Invalid PayPal access token response");
  }
  return {
    accessToken: parsed.data.access_token,
    expiresIn: parsed.data.expires_in,
  };
}
