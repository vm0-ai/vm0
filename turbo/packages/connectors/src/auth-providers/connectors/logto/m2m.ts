import { z } from "zod";

import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

const TENANT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

export async function fetchLogtoAccessToken(args: {
  readonly tenantId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly signal: AbortSignal;
}) {
  if (!TENANT_ID.test(args.tenantId)) {
    throw new Error("Invalid Logto tenant ID");
  }
  const tenantId = args.tenantId.toLowerCase();
  // Logto Cloud does not serve the token endpoint on a tenant's custom domain,
  // so the default tenant endpoint is the only valid host here.
  const response = await fetch(`https://${tenantId}.logto.app/oidc/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${args.appId}:${args.appSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      resource: `https://${tenantId}.logto.app/api`,
      scope: "all",
    }),
    signal: args.signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(
      `Logto access token request failed: ${response.status}`,
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
    throw new ProviderResponseError("Invalid Logto access token response");
  }
  return {
    accessToken: parsed.data.access_token,
    expiresIn: parsed.data.expires_in,
  };
}
