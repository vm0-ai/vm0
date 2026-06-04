import { z } from "zod";

const LARK_TENANT_ACCESS_TOKEN_URL =
  "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal";

const larkTenantAccessTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  tenant_access_token: z.string().optional(),
  expire: z.number().optional(),
});

export interface LarkTenantAccessTokenResult {
  readonly accessToken: string;
  readonly expiresIn: number;
}

export async function fetchLarkTenantAccessToken(args: {
  readonly appId: string;
  readonly appSecret: string;
  readonly signal: AbortSignal;
}): Promise<LarkTenantAccessTokenResult> {
  const response = await fetch(LARK_TENANT_ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      app_id: args.appId,
      app_secret: args.appSecret,
    }),
    signal: args.signal,
  });

  if (!response.ok) {
    throw new Error(
      `Lark tenant access token request failed: ${response.status}`,
    );
  }

  const data = larkTenantAccessTokenResponseSchema.parse(await response.json());

  if (data.code !== 0) {
    throw new Error(data.msg ?? `Lark tenant access token error ${data.code}`);
  }
  if (!data.tenant_access_token) {
    throw new Error("Missing Lark tenant access token");
  }
  if (data.expire === undefined || data.expire <= 0) {
    throw new Error("Missing Lark tenant access token expiry");
  }

  return {
    accessToken: data.tenant_access_token,
    expiresIn: data.expire,
  };
}
