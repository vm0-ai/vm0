import { createHmac } from "node:crypto";

import { env } from "../../lib/env";
import { now } from "./time";

const AVATAR_URL_TTL_SECONDS = 24 * 60 * 60;

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function computeAvatarHmacSignature(
  botId: string,
  secret: string,
  expiresAt: number,
): string {
  return createHmac("sha256", secret)
    .update(`${expiresAt}.${botId}`)
    .digest("hex");
}

export function buildTelegramBotAvatarUrl(botId: string): string {
  const secretsKey = env("SECRETS_ENCRYPTION_KEY");
  const apiUrl = env("VM0_API_URL");
  const path = `/api/integrations/telegram/${encodeURIComponent(botId)}/avatar`;
  const expiresAt = Math.floor(now() / 1000) + AVATAR_URL_TTL_SECONDS;
  const signature = computeAvatarHmacSignature(botId, secretsKey, expiresAt);
  const query = new URLSearchParams({
    exp: String(expiresAt),
    sig: signature,
  });
  const signedPath = `${path}?${query.toString()}`;
  if (!apiUrl) {
    return signedPath;
  }
  return `${trimTrailingSlash(apiUrl)}${signedPath}`;
}
