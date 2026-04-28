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

function errorResponse(
  status: number,
  message: string,
  code: string,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
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
      return errorResponse(404, "Telegram bot avatar not found", "NOT_FOUND");
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
      return errorResponse(
        404,
        "Telegram avatar does not have a downloadable path",
        "NOT_FOUND",
      );
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
