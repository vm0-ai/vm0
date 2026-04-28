import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { decryptSecretValue } from "../../../../../../src/lib/shared/crypto/secrets-encryption";
import { inferMimetype } from "../../../../../../src/lib/shared/mimetype";
import { logger } from "../../../../../../src/lib/shared/logger";
import { verifyTelegramBotAvatarUrlSignature } from "../../../../../../src/lib/zero/telegram/avatar-url";
import {
  buildFileDownloadUrl,
  createTelegramClient,
  getFile,
  getUserProfilePhotos,
  type TelegramUserProfilePhoto,
} from "../../../../../../src/lib/zero/telegram/client";

const log = logger("api:telegram:integration-bot-avatar");

const MAX_AVATAR_SIZE_BYTES = 10 * 1024 * 1024;
const FALLBACK_AVATAR_SVG = [
  `<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Telegram bot avatar fallback">`,
  `<circle cx="20" cy="20" r="20" fill="#2AABEE" fill-opacity="0.1"/>`,
  `<svg x="10" y="10" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2AABEE" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">`,
  `<path d="M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4"/>`,
  `<path d="M12 2v2"/>`,
  `<path d="M9 12v9"/>`,
  `<path d="M15 12v9"/>`,
  `<path d="M5 16l4 -2"/>`,
  `<path d="M15 14l4 2"/>`,
  `<path d="M9 18h6"/>`,
  `<path d="M10 8v.01"/>`,
  `<path d="M14 8v.01"/>`,
  `</svg>`,
  `</svg>`,
].join("");

function errorResponse(
  status: number,
  message: string,
  code: string,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

function fallbackAvatarResponse(): Response {
  const headers = new Headers();
  headers.set("Content-Type", "image/svg+xml; charset=utf-8");
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(FALLBACK_AVATAR_SVG, { status: 200, headers });
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) return undefined;
  return size;
}

function selectLargestProfilePhoto(
  photos: TelegramUserProfilePhoto[],
): TelegramUserProfilePhoto | null {
  if (photos.length === 0) {
    return null;
  }

  return photos.reduce((largest, photo) => {
    return photo.width * photo.height > largest.width * largest.height
      ? photo
      : largest;
  }, photos[0]!);
}

function telegramProfileUserId(botId: string): string | number {
  const numericBotId = Number(botId);
  if (Number.isSafeInteger(numericBotId) && String(numericBotId) === botId) {
    return numericBotId;
  }
  return botId;
}

async function loadBotToken(params: {
  botId: string;
  orgId?: string;
}): Promise<string | null> {
  const where = params.orgId
    ? and(
        eq(telegramInstallations.telegramBotId, params.botId),
        eq(telegramInstallations.orgId, params.orgId),
      )
    : eq(telegramInstallations.telegramBotId, params.botId);

  const [installation] = await globalThis.services.db
    .select({
      encryptedBotToken: telegramInstallations.encryptedBotToken,
    })
    .from(telegramInstallations)
    .where(where)
    .limit(1);

  if (!installation) {
    return null;
  }

  return decryptSecretValue(
    installation.encryptedBotToken,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );
}

async function resolveBotTokenForRequest(
  request: Request,
  botId: string,
): Promise<string | NextResponse> {
  const requestUrl = new URL(request.url);
  const hasValidSignature = verifyTelegramBotAvatarUrlSignature({
    botId,
    expiresAt: requestUrl.searchParams.get("exp"),
    signature: requestUrl.searchParams.get("sig"),
  });

  if (hasValidSignature) {
    const botToken = await loadBotToken({ botId });
    return (
      botToken ?? errorResponse(404, "Telegram bot not found", "NOT_FOUND")
    );
  }

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx) {
    return errorResponse(401, "Not authenticated", "UNAUTHORIZED");
  }

  const { org } = await resolveOrg(authCtx);
  const botToken = await loadBotToken({ botId, orgId: org.orgId });
  return botToken ?? errorResponse(404, "Telegram bot not found", "NOT_FOUND");
}

/**
 * GET /api/integrations/telegram/[botId]/avatar
 *
 * Proxies the bot's Telegram profile photo without exposing the bot token.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ botId: string }> },
): Promise<Response> {
  initServices();

  const { botId } = await params;
  const botTokenResult = await resolveBotTokenForRequest(request, botId);
  if (botTokenResult instanceof NextResponse) {
    return botTokenResult;
  }
  const botToken = botTokenResult;

  try {
    const client = createTelegramClient(botToken);
    const profilePhotos = await getUserProfilePhotos(
      client,
      telegramProfileUserId(botId),
      1,
    );
    const photo = selectLargestProfilePhoto(profilePhotos.photos[0] ?? []);
    if (!photo) {
      return fallbackAvatarResponse();
    }

    if (photo.file_size && photo.file_size > MAX_AVATAR_SIZE_BYTES) {
      return errorResponse(
        413,
        `Avatar exceeds maximum size of ${MAX_AVATAR_SIZE_BYTES} bytes`,
        "PAYLOAD_TOO_LARGE",
      );
    }

    const file = await getFile(client, photo.file_id);
    if (!file.file_path) {
      return fallbackAvatarResponse();
    }

    if (file.file_size && file.file_size > MAX_AVATAR_SIZE_BYTES) {
      return errorResponse(
        413,
        `Avatar exceeds maximum size of ${MAX_AVATAR_SIZE_BYTES} bytes`,
        "PAYLOAD_TOO_LARGE",
      );
    }

    const downloadResponse = await fetch(
      buildFileDownloadUrl(botToken, file.file_path),
      { signal: request.signal },
    );

    if (!downloadResponse.ok) {
      log.warn("Telegram bot avatar download failed", {
        botId,
        status: downloadResponse.status,
      });
      return errorResponse(
        502,
        `Failed to download avatar from Telegram: ${downloadResponse.status}`,
        "BAD_GATEWAY",
      );
    }

    const responseContentType =
      downloadResponse.headers.get("content-type") ?? "";
    if (responseContentType.includes("text/html")) {
      log.warn("Telegram returned HTML for bot avatar", {
        botId,
        contentType: responseContentType,
      });
      return errorResponse(
        502,
        "Telegram returned an unexpected response",
        "BAD_GATEWAY",
      );
    }

    const contentLength = downloadResponse.headers.get("content-length");
    const contentLengthBytes = parseContentLength(contentLength);
    if (
      contentLengthBytes !== undefined &&
      contentLengthBytes > MAX_AVATAR_SIZE_BYTES
    ) {
      return errorResponse(
        413,
        `Avatar exceeds maximum size of ${MAX_AVATAR_SIZE_BYTES} bytes`,
        "PAYLOAD_TOO_LARGE",
      );
    }

    const fileName = file.file_path.split("/").pop() ?? photo.file_id;
    const mimetype = responseContentType || inferMimetype(fileName);
    const headers = new Headers();
    headers.set("Content-Type", mimetype);
    headers.set("Cache-Control", "private, max-age=300");
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    return new Response(downloadResponse.body, { status: 200, headers });
  } catch (error) {
    log.warn("Telegram bot avatar proxy failed", { botId, error });
    return errorResponse(
      502,
      "Failed to load Telegram bot avatar",
      "BAD_GATEWAY",
    );
  }
}
