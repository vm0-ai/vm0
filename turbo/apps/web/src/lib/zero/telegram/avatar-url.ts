import { env } from "../../../env";
import {
  computeHmacSignature,
  verifyHmacSignature,
} from "../../infra/callback/hmac";

const AVATAR_URL_TTL_SECONDS = 24 * 60 * 60;

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function buildTelegramBotAvatarUrl(botId: string): string {
  const { SECRETS_ENCRYPTION_KEY, VM0_API_URL } = env();
  const path = `/api/integrations/telegram/${encodeURIComponent(botId)}/avatar`;
  const expiresAt = Math.floor(Date.now() / 1000) + AVATAR_URL_TTL_SECONDS;
  const signature = computeHmacSignature(
    botId,
    SECRETS_ENCRYPTION_KEY,
    expiresAt,
  );
  const query = new URLSearchParams({
    exp: String(expiresAt),
    sig: signature,
  });
  const signedPath = `${path}?${query.toString()}`;

  if (!VM0_API_URL) {
    return signedPath;
  }
  return `${trimTrailingSlash(VM0_API_URL)}${signedPath}`;
}

export function verifyTelegramBotAvatarUrlSignature(params: {
  botId: string;
  expiresAt: string | null;
  signature: string | null;
}): boolean {
  if (!params.expiresAt || !params.signature) {
    return false;
  }

  const expiresAt = Number(params.expiresAt);
  if (!Number.isSafeInteger(expiresAt)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (expiresAt < now) {
    return false;
  }

  return verifyHmacSignature(
    params.botId,
    env().SECRETS_ENCRYPTION_KEY,
    expiresAt,
    params.signature,
  );
}
