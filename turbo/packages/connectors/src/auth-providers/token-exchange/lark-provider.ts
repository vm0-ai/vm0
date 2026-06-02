import { z } from "zod";

import type { TokenExchangeAccessProvider } from "../types";

const LARK_TENANT_ACCESS_TOKEN_URL =
  "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal";

const larkTenantAccessTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  tenant_access_token: z.string().optional(),
  expire: z.number().optional(),
});

function requireValue(
  values: Readonly<Record<string, string>>,
  name: string,
): string {
  const value = values[name];
  if (!value) {
    throw new Error(`Lark token exchange missing ${name}`);
  }
  return value;
}

async function exchangeLarkTenantAccessToken(args: {
  readonly appId: string;
  readonly appSecret: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly accessToken: string; readonly expiresIn: number }> {
  const response = await fetch(LARK_TENANT_ACCESS_TOKEN_URL, {
    signal: args.signal,
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      app_id: args.appId,
      app_secret: args.appSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Lark token exchange failed: HTTP ${response.status}`);
  }

  const data = larkTenantAccessTokenResponseSchema.parse(await response.json());
  if (data.code !== 0) {
    const reason = data.msg ? ` ${data.msg}` : "";
    throw new Error(`Lark token exchange failed: ${data.code}${reason}`);
  }
  if (!data.tenant_access_token) {
    throw new Error("Lark token exchange response missing tenant_access_token");
  }
  if (!data.expire || data.expire <= 0) {
    throw new Error("Lark token exchange response missing positive expire");
  }

  return {
    accessToken: data.tenant_access_token,
    expiresIn: data.expire,
  };
}

export const larkProvider: TokenExchangeAccessProvider = {
  kind: "token-exchange",
  getAccessSecretName: () => {
    return "LARK_ACCESS_TOKEN";
  },
  exchangeToken: async (args) => {
    return await exchangeLarkTenantAccessToken({
      appId: requireValue(args.variables, "LARK_APP_ID"),
      appSecret: requireValue(args.secrets, "LARK_APP_SECRET"),
      signal: args.signal,
    });
  },
};
