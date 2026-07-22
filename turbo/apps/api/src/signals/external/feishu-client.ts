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

const feishuResponseSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
});

interface FeishuTenantAccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
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

async function getFeishuTenantAccessToken(args: {
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
