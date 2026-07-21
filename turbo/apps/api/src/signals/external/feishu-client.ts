import { z } from "zod";
import { eq } from "drizzle-orm";
import { feishuAppCredentials } from "@vm0/db/schema/feishu-app-credential";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import type { Db } from "./db";
import { nowDate } from "./time";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "../services/crypto.utils";
import type { FeishuConfig } from "../services/feishu-config";

const FEISHU_API_ORIGIN = "https://open.feishu.cn";
const TOKEN_REFRESH_WINDOW_MS = 3 * 60 * 1000;

const appAccessTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  app_access_token: z.string().optional(),
  expire: z.number().optional(),
});

const tenantAccessTokenResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  tenant_access_token: z.string().optional(),
  expire: z.number().optional(),
});

const feishuResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
});

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

async function loadAppAccessToken(args: {
  readonly db: Db;
  readonly config: FeishuConfig;
  readonly signal: AbortSignal;
}): Promise<string> {
  const [credential] = await args.db
    .select()
    .from(feishuAppCredentials)
    .where(eq(feishuAppCredentials.appId, args.config.appId))
    .limit(1);
  args.signal.throwIfAborted();
  if (!credential) {
    throw new Error("Feishu app_ticket has not been received yet");
  }
  if (
    credential.encryptedAppAccessToken &&
    tokenIsFresh(credential.appAccessTokenExpiresAt)
  ) {
    return await decryptPersistentSecretValue(
      credential.encryptedAppAccessToken,
      {},
    );
  }

  const appTicket = await decryptPersistentSecretValue(
    credential.encryptedAppTicket,
    {},
  );
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/auth/v3/app_access_token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: args.config.appId,
        app_secret: args.config.appSecret,
        app_ticket: appTicket,
      }),
      signal: args.signal,
    },
  );
  const parsed = appAccessTokenResponseSchema.parse(await readJson(response));
  if (parsed.code !== 0 || !parsed.app_access_token || !parsed.expire) {
    throw new Error(parsed.msg ?? "Feishu app access token request failed");
  }
  const encryptedToken = await encryptPersistentSecretValue(
    parsed.app_access_token,
    {},
  );
  await args.db
    .update(feishuAppCredentials)
    .set({
      encryptedAppAccessToken: encryptedToken,
      appAccessTokenExpiresAt: new Date(
        nowDate().getTime() + parsed.expire * 1000,
      ),
      updatedAt: nowDate(),
    })
    .where(eq(feishuAppCredentials.appId, args.config.appId));
  args.signal.throwIfAborted();
  return parsed.app_access_token;
}

async function getFeishuTenantAccessToken(args: {
  readonly db: Db;
  readonly config: FeishuConfig;
  readonly tenantKey: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const [installation] = await args.db
    .select()
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.feishuTenantKey, args.tenantKey))
    .limit(1);
  args.signal.throwIfAborted();
  if (!installation) {
    throw new Error("Feishu installation not found");
  }
  if (
    installation.encryptedTenantAccessToken &&
    tokenIsFresh(installation.tenantAccessTokenExpiresAt)
  ) {
    return await decryptPersistentSecretValue(
      installation.encryptedTenantAccessToken,
      {},
    );
  }

  const appAccessToken = await loadAppAccessToken(args);
  const response = await fetch(
    `${FEISHU_API_ORIGIN}/open-apis/auth/v3/tenant_access_token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_access_token: appAccessToken,
        tenant_key: args.tenantKey,
      }),
      signal: args.signal,
    },
  );
  const parsed = tenantAccessTokenResponseSchema.parse(
    await readJson(response),
  );
  if (parsed.code !== 0 || !parsed.tenant_access_token || !parsed.expire) {
    throw new Error(parsed.msg ?? "Feishu tenant access token request failed");
  }
  const encryptedToken = await encryptPersistentSecretValue(
    parsed.tenant_access_token,
    {},
  );
  await args.db
    .update(feishuOrgInstallations)
    .set({
      encryptedTenantAccessToken: encryptedToken,
      tenantAccessTokenExpiresAt: new Date(
        nowDate().getTime() + parsed.expire * 1000,
      ),
      updatedAt: nowDate(),
    })
    .where(eq(feishuOrgInstallations.feishuTenantKey, args.tenantKey));
  args.signal.throwIfAborted();
  return parsed.tenant_access_token;
}

export async function replyToFeishuMessage(args: {
  readonly db: Db;
  readonly config: FeishuConfig;
  readonly tenantKey: string;
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
