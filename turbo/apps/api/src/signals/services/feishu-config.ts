import { eq } from "drizzle-orm";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { env } from "../../lib/env";
import type { Db } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";

export interface FeishuInstallationConfig {
  readonly id: string;
  readonly orgId: string;
  readonly ownerUserId: string | null;
  readonly appId: string;
  readonly botOpenId: string | null;
  readonly appSecret: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
  readonly callbackVerified: boolean;
}

export async function loadFeishuInstallationConfig(
  db: Db,
  installationId: string,
): Promise<FeishuInstallationConfig | null> {
  const [installation] = await db
    .select({
      id: feishuOrgInstallations.id,
      orgId: feishuOrgInstallations.orgId,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      appId: feishuOrgInstallations.appId,
      botOpenId: feishuOrgInstallations.botOpenId,
      encryptedAppSecret: feishuOrgInstallations.encryptedAppSecret,
      encryptedVerificationToken:
        feishuOrgInstallations.encryptedVerificationToken,
      encryptedEncryptKey: feishuOrgInstallations.encryptedEncryptKey,
      callbackVerifiedAt: feishuOrgInstallations.callbackVerifiedAt,
    })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.id, installationId))
    .limit(1);
  if (!installation) {
    return null;
  }
  const context = { orgId: installation.orgId };
  const [appSecret, verificationToken, encryptKey] = await Promise.all([
    decryptPersistentSecretValue(installation.encryptedAppSecret, context),
    decryptPersistentSecretValue(
      installation.encryptedVerificationToken,
      context,
    ),
    decryptPersistentSecretValue(installation.encryptedEncryptKey, context),
  ]);
  return {
    id: installation.id,
    orgId: installation.orgId,
    ownerUserId: installation.ownerUserId,
    appId: installation.appId,
    botOpenId: installation.botOpenId,
    appSecret,
    verificationToken,
    encryptKey,
    callbackVerified: Boolean(installation.callbackVerifiedAt),
  };
}

export function feishuCallbackUrl(installationId: string): string {
  return new URL(
    `/api/zero/feishu/events/${encodeURIComponent(installationId)}`,
    env("FEISHU_CALLBACK_BASE_URL"),
  ).toString();
}

export function feishuOAuthCallbackUrl(): string {
  return new URL(
    "/api/zero/feishu/oauth/callback",
    env("FEISHU_CALLBACK_BASE_URL"),
  ).toString();
}

export function feishuOAuthConnectUrl(state: string): string {
  const url = new URL(
    "/api/zero/feishu/oauth/connect",
    env("VM0_API_BACKEND_URL") ?? env("VM0_WEB_URL"),
  );
  url.searchParams.set("state", state);
  return url.toString();
}

export function feishuBotOpenUrl(appId: string): string {
  const url = new URL("https://applink.feishu.cn/client/bot/open");
  url.searchParams.set("appId", appId);
  return url.toString();
}

export function feishuChatOpenUrl(chatId: string): string {
  const url = new URL("https://applink.feishu.cn/client/chat/open");
  url.searchParams.set("openChatId", chatId);
  return url.toString();
}
