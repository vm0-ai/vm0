import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { decryptSecretValue } from "../../../../../../src/lib/shared/crypto/secrets-encryption";
import {
  buildFileDownloadUrl,
  createTelegramClient,
  getFile,
} from "../../../../../../src/lib/zero/telegram/client";
import { inferMimetype } from "../../../../../../src/lib/shared/mimetype";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("api:zero:integrations:telegram:download-file");

/** Maximum file size to proxy (100MB). */
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

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

type TelegramFileMetadata = {
  botToken: string;
  filePath: string;
  fileName: string;
  mimetype: string;
};

async function resolveTelegramFileMetadata(
  orgId: string,
  botId: string,
  fileId: string,
): Promise<TelegramFileMetadata | NextResponse> {
  const [row] = await globalThis.services.db
    .select({
      encryptedBotToken: telegramInstallations.encryptedBotToken,
    })
    .from(telegramInstallations)
    .where(
      and(
        eq(telegramInstallations.telegramBotId, botId),
        eq(telegramInstallations.orgId, orgId),
      ),
    )
    .limit(1);

  if (!row) {
    return errorResponse(404, "Telegram bot not found", "NOT_FOUND");
  }

  const botToken = decryptSecretValue(
    row.encryptedBotToken,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );
  const client = createTelegramClient(botToken);
  const file = await getFile(client, fileId);

  if (!file.file_path) {
    return errorResponse(
      404,
      "Telegram file does not have a downloadable path",
      "NOT_FOUND",
    );
  }

  if (file.file_size && file.file_size > MAX_FILE_SIZE_BYTES) {
    return errorResponse(
      413,
      `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
      "PAYLOAD_TOO_LARGE",
    );
  }

  const fileName = file.file_path.split("/").pop() ?? fileId;

  return {
    botToken,
    filePath: file.file_path,
    fileName,
    mimetype: inferMimetype(fileName),
  };
}

/**
 * GET /api/zero/integrations/telegram/download-file?file_id=<id>&bot_id=<id>
 *
 * Streams a Telegram file to the caller using the owning org's bot token.
 * Requires `telegram:read` capability. `telegram:write` also satisfies this.
 */
export async function GET(request: NextRequest): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const authCtx = await requireAuth(authHeader, {
    requiredCapability: "telegram:read",
  });
  if (isAuthError(authCtx)) {
    return NextResponse.json(authCtx.body, { status: authCtx.status });
  }

  if (!authCtx.orgId) {
    return errorResponse(403, "Organization context is required", "FORBIDDEN");
  }

  const fileId = request.nextUrl.searchParams.get("file_id");
  if (!fileId) {
    return errorResponse(
      400,
      "file_id query parameter is required",
      "BAD_REQUEST",
    );
  }
  const botId = request.nextUrl.searchParams.get("bot_id");
  if (!botId) {
    return errorResponse(
      400,
      "bot_id query parameter is required",
      "BAD_REQUEST",
    );
  }

  try {
    const meta = await resolveTelegramFileMetadata(
      authCtx.orgId,
      botId,
      fileId,
    );
    if (meta instanceof NextResponse) return meta;

    const downloadUrl = buildFileDownloadUrl(meta.botToken, meta.filePath);
    const downloadResponse = await fetch(downloadUrl, {
      signal: request.signal,
    });

    if (!downloadResponse.ok) {
      log.warn("Telegram download failed", {
        fileId,
        status: downloadResponse.status,
      });
      return errorResponse(
        502,
        `Failed to download file from Telegram: ${downloadResponse.status}`,
        "BAD_GATEWAY",
      );
    }

    const responseContentType =
      downloadResponse.headers.get("content-type") ?? "";
    if (responseContentType.includes("text/html")) {
      log.warn("Telegram returned HTML", {
        fileId,
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
      contentLengthBytes > MAX_FILE_SIZE_BYTES
    ) {
      return errorResponse(
        413,
        `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
        "PAYLOAD_TOO_LARGE",
      );
    }

    const mimetype = responseContentType || meta.mimetype;
    const headers = new Headers();
    headers.set("Content-Type", mimetype);
    headers.set("X-File-Name", encodeURIComponent(meta.fileName));
    headers.set("X-File-Mimetype", mimetype);
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    return new Response(downloadResponse.body, { status: 200, headers });
  } catch (error) {
    log.warn("Telegram file download failed", { fileId, error });
    return errorResponse(
      502,
      "Failed to download file from Telegram",
      "BAD_GATEWAY",
    );
  }
}
