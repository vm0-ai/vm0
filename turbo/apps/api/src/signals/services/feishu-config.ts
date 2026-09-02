import { eq } from "drizzle-orm";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  apiUrlForPublicBrand,
  appUrlForPublicBrand,
} from "@okouai/core/public-brand";

import { apiBackendUrl } from "../../lib/api-backend-url";
import { env } from "../../lib/env";
import { webUrl } from "../../lib/web-url";
import type { Db } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";

export interface FeishuInstallationConfig {
  readonly id: string;
  readonly orgId: string;
  readonly ownerUserId: string | null;
  readonly appId: string;
  readonly botOpenId: string | null;
  readonly encryptedAppSecret: string;
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
    encryptedAppSecret: installation.encryptedAppSecret,
    appSecret,
    verificationToken,
    encryptKey,
    callbackVerified: Boolean(installation.callbackVerifiedAt),
  };
}

/**
 * The event subscription URL an operator registers in their own Feishu Open
 * Platform app. #28278 step 3 switches this producer to the final path; the
 * branded paths stay routable, so installations that already hold the old URL
 * keep delivering events. The hostname carries the installation's product
 * brand while the path and installation ID remain provider-compatible.
 */
export function feishuCallbackUrl(
  installationId: string,
  publicBrand: PublicBrand,
): string {
  return new URL(
    `/api/webhooks/feishu/events/${encodeURIComponent(installationId)}`,
    apiUrlForPublicBrand(env("FEISHU_CALLBACK_BASE_URL"), publicBrand),
  ).toString();
}

/**
 * The redirect URI for the OAuth branch that does not hand off to the frontend,
 * reached only when `callbackTarget` is absent. The Feishu console holds
 * `feishuOAuthAppCallbackUrl()` instead, so nothing outside this service pins
 * this path; #28544 moved it off the legacy `/api/zero/**` namespace it had
 * kept, to the neutral path its contract now declares. Both branded forms stay
 * routable through `MIGRATED_BRANDED_PATHS`.
 */
export function feishuOAuthCallbackUrl(): string {
  return new URL(
    "/api/integrations/feishu/oauth/callback",
    env("FEISHU_CALLBACK_BASE_URL"),
  ).toString();
}

export function feishuOAuthAppCallbackUrl(publicBrand: PublicBrand): string {
  return new URL(
    "/connectors/feishu/callback",
    appUrlForPublicBrand(env("APP_URL"), publicBrand),
  ).toString();
}

/**
 * Redirect URI emitted before Feishu OAuth became brand-aware. Keep this only
 * for in-flight signed state and persisted connector state created by an older
 * release, which must replay the byte-for-byte URI that the provider received.
 */
export function legacyFeishuOAuthAppCallbackUrl(): string {
  return new URL("/connectors/feishu/callback", env("APP_URL")).toString();
}

export function feishuOAuthConnectUrl(
  state: string,
  publicBrand: PublicBrand,
): string {
  const url = new URL(
    "/api/feishu/oauth/connect",
    apiUrlForPublicBrand(apiBackendUrl() ?? webUrl(), publicBrand),
  );
  url.searchParams.set("state", state);
  return url.toString();
}

export function feishuBotOpenUrl(appId: string): string {
  const url = new URL("https://applink.feishu.cn/client/bot/open");
  url.searchParams.set("appId", appId);
  return url.toString();
}

export function buildFeishuChatOpenUrl(chatId: string): string {
  const url = new URL("https://applink.feishu.cn/client/chat/open");
  url.searchParams.set("openChatId", chatId);
  return url.toString();
}
