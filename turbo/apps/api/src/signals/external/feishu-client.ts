import { z } from "zod";
import { eq } from "drizzle-orm";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import type { Db } from "./db";
import { nowDate } from "./time";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "../services/crypto.utils";

const FEISHU_API_ORIGIN = "https://open.feishu.cn";
const TOKEN_REFRESH_WINDOW_MS = 3 * 60 * 1000;

const tenantAccessTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  tenant_access_token: z.string().optional(),
  expire: z.number().optional(),
});

const feishuBotInfoSchema = z.object({
  app_name: z.string().optional(),
  avatar_url: z.string().optional(),
});

const feishuBotInfoResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  bot: feishuBotInfoSchema.optional(),
  data: z.object({ bot: feishuBotInfoSchema.optional() }).optional(),
});

const feishuOAuthTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  access_token: z.string().optional(),
});

const feishuUserInfoResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      name: z.string().optional(),
      open_id: z.string().optional(),
      tenant_key: z.string().optional(),
    })
    .optional(),
});

const feishuResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
});

interface FeishuTenantAccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

interface FeishuBotInfo {
  readonly name: string;
  readonly avatarUrl: string | null;
}

export interface FeishuUserInfo {
  readonly name: string | null;
  readonly openId: string;
  readonly tenantKey: string | null;
}

export class InvalidFeishuCredentialsError extends Error {}

function tokenIsFresh(expiresAt: Date | null): boolean {
  return (
    expiresAt !== null &&
    expiresAt.getTime() > nowDate().getTime() + TOKEN_REFRESH_WINDOW_MS
  );
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Feishu API returned HTTP ${response.status}`);
  }
  return body;
}

export async function fetchFeishuTenantAccessToken(args: {
  readonly appId: string;
  readonly appSecret: string;
  readonly signal: AbortSignal;
}): Promise<FeishuTenantAccessToken> {
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: args.appId,
        app_secret: args.appSecret,
      }),
      signal: args.signal,
    },
  );
  const parsed = tenantAccessTokenResponseSchema.parse(
    await readJson(response),
  );
  if (parsed.code !== 0) {
    throw new InvalidFeishuCredentialsError(
      parsed.msg ?? "Feishu rejected the app credentials",
    );
  }
  if (!parsed.tenant_access_token || !parsed.expire) {
    throw new Error("Feishu tenant access token response is incomplete");
  }
  return {
    token: parsed.tenant_access_token,
    expiresInSeconds: parsed.expire,
  };
}

export async function fetchFeishuBotInfo(args: {
  readonly tenantAccessToken: string;
  readonly signal: AbortSignal;
}): Promise<FeishuBotInfo> {
  const response = await fetch(`${FEISHU_API_ORIGIN}/open-apis/bot/v3/info`, {
    headers: {
      authorization: `Bearer ${args.tenantAccessToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    signal: args.signal,
  });
  const parsed = feishuBotInfoResponseSchema.parse(await readJson(response));
  if (parsed.code !== 0) {
    throw new Error(parsed.msg ?? "Feishu bot info request failed");
  }
  const bot = parsed.bot ?? parsed.data?.bot;
  if (!bot?.app_name) {
    throw new Error("Feishu bot info response is incomplete");
  }
  return {
    name: bot.app_name,
    avatarUrl: bot.avatar_url ?? null,
  };
}

export async function exchangeFeishuOAuthCode(args: {
  readonly appId: string;
  readonly appSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/authen/v2/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: args.appId,
        client_secret: args.appSecret,
        code: args.code,
        redirect_uri: args.redirectUri,
      }),
      signal: args.signal,
    },
  );
  const parsed = feishuOAuthTokenResponseSchema.parse(await readJson(response));
  if (parsed.code !== 0) {
    throw new Error(parsed.msg ?? "Feishu OAuth exchange failed");
  }
  if (!parsed.access_token) {
    throw new Error("Feishu OAuth token response is incomplete");
  }
  return parsed.access_token;
}

export async function fetchFeishuUserInfo(args: {
  readonly userAccessToken: string;
  readonly signal: AbortSignal;
}): Promise<FeishuUserInfo> {
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/authen/v1/user_info`,
    {
      headers: {
        authorization: `Bearer ${args.userAccessToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      signal: args.signal,
    },
  );
  const parsed = feishuUserInfoResponseSchema.parse(await readJson(response));
  if (parsed.code !== 0) {
    throw new Error(parsed.msg ?? "Feishu user info request failed");
  }
  if (!parsed.data?.open_id) {
    throw new Error("Feishu user info response is incomplete");
  }
  return {
    name: parsed.data.name ?? null,
    openId: parsed.data.open_id,
    tenantKey: parsed.data.tenant_key ?? null,
  };
}

export async function getFeishuTenantAccessToken(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const [installation] = await args.db
    .select()
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.id, args.installationId))
    .limit(1);
  args.signal.throwIfAborted();
  if (!installation) {
    throw new Error("Feishu installation not found");
  }
  const context = { orgId: installation.orgId };
  if (
    installation.encryptedTenantAccessToken &&
    tokenIsFresh(installation.tenantAccessTokenExpiresAt)
  ) {
    return await decryptPersistentSecretValue(
      installation.encryptedTenantAccessToken,
      context,
    );
  }

  const appSecret = await decryptPersistentSecretValue(
    installation.encryptedAppSecret,
    context,
  );
  const token = await fetchFeishuTenantAccessToken({
    appId: installation.appId,
    appSecret,
    signal: args.signal,
  });
  const encryptedToken = await encryptPersistentSecretValue(
    token.token,
    context,
  );
  await args.db
    .update(feishuOrgInstallations)
    .set({
      encryptedTenantAccessToken: encryptedToken,
      tenantAccessTokenExpiresAt: new Date(
        nowDate().getTime() + token.expiresInSeconds * 1000,
      ),
      updatedAt: nowDate(),
    })
    .where(eq(feishuOrgInstallations.id, args.installationId));
  args.signal.throwIfAborted();
  return token.token;
}

export async function replyToFeishuMessage(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly messageId: string;
  readonly text: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const token = await getFeishuTenantAccessToken(args);
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}/reply`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        content: JSON.stringify({ text: args.text }),
        msg_type: "text",
      }),
      signal: args.signal,
    },
  );
  const parsed = feishuResponseSchema.parse(await readJson(response));
  if (parsed.code !== 0) {
    throw new Error(parsed.msg ?? "Feishu message reply failed");
  }
}
