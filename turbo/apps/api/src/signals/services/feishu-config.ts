import { eq } from "drizzle-orm";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { env, optionalEnv } from "../../lib/env";
import type { Db } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";

export interface FeishuInstallationConfig {
  readonly id: string;
  readonly orgId: string;
  readonly appId: string;
  readonly appSecret: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
}

export async function loadFeishuInstallationConfig(
  db: Db,
  installationId: string,
): Promise<FeishuInstallationConfig | null> {
  const [installation] = await db
    .select({
      id: feishuOrgInstallations.id,
      orgId: feishuOrgInstallations.orgId,
      appId: feishuOrgInstallations.appId,
      encryptedAppSecret: feishuOrgInstallations.encryptedAppSecret,
      encryptedVerificationToken:
        feishuOrgInstallations.encryptedVerificationToken,
      encryptedEncryptKey: feishuOrgInstallations.encryptedEncryptKey,
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
    appId: installation.appId,
    appSecret,
    verificationToken,
    encryptKey,
  };
}

export function feishuCallbackUrl(installationId: string): string {
  const baseUrl = optionalEnv("VM0_API_BACKEND_URL") ?? env("VM0_WEB_URL");
  return new URL(
    `/api/zero/feishu/events/${encodeURIComponent(installationId)}`,
    baseUrl,
  ).toString();
}
