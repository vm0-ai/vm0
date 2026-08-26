import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { webUrl } from "../../lib/web-url";

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

export function verifyTelegramBotAvatarUrlSignature(params: {
  readonly botId: string;
  readonly expiresAt: string | undefined;
  readonly signature: string | undefined;
}): boolean {
  if (!params.expiresAt || !params.signature) {
    return false;
  }

  const expiresAt = Number(params.expiresAt);
  if (!Number.isSafeInteger(expiresAt)) {
    return false;
  }

  if (expiresAt < Math.floor(now() / 1000)) {
    return false;
  }

  const expected = Buffer.from(
    computeAvatarHmacSignature(
      params.botId,
      env("SECRETS_ENCRYPTION_KEY"),
      expiresAt,
    ),
    "hex",
  );
  const received = Buffer.from(params.signature, "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export function buildTelegramBotAvatarUrl(botId: string): string {
  const secretsKey = env("SECRETS_ENCRYPTION_KEY");
  const configuredWebUrl = webUrl();
  const path = `/api/integrations/telegram/${encodeURIComponent(botId)}/avatar`;
  const expiresAt = Math.floor(now() / 1000) + AVATAR_URL_TTL_SECONDS;
  const signature = computeAvatarHmacSignature(botId, secretsKey, expiresAt);
  const query = new URLSearchParams({
    exp: String(expiresAt),
    sig: signature,
  });
  const signedPath = `${path}?${query.toString()}`;
  if (!configuredWebUrl) {
    return signedPath;
  }
  return `${trimTrailingSlash(configuredWebUrl)}${signedPath}`;
}
