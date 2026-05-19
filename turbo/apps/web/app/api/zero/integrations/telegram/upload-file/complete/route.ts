import {
  createHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { integrationsTelegramUploadCompleteContract } from "@vm0/api-contracts/contracts/integrations";
import { and, eq } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { initServices } from "../../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../../src/lib/auth/require-auth";
import { listS3Objects } from "../../../../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../../../../src/env";
import {
  buildArtifactPrefix,
  buildFileUrl,
} from "../../../../../../../src/lib/zero/uploads/file-url";
import { recordRunUploadedFile } from "../../../../../../../src/lib/zero/uploads/run-uploaded-files";
import { decryptSecretValue } from "../../../../../../../src/lib/shared/crypto/secrets-encryption";
import { inferMimetype } from "../../../../../../../src/lib/shared/mimetype";
import {
  createTelegramClient,
  isTelegramApiError,
  sendDocument,
} from "../../../../../../../src/lib/zero/telegram/client";
import {
  getOfficialTelegramBotConfig,
  isOfficialTelegramBotId,
} from "../../../../../../../src/lib/zero/telegram/official";
import type {
  TelegramUploadCompleteBody,
  TelegramUploadCompleteResponse,
} from "@vm0/api-contracts/contracts/integrations";

type UploadedObject = {
  key: string;
  size: number;
};

type RouteErrorStatus = 400 | 403 | 404 | 502;

type RouteErrorResponse<TStatus extends RouteErrorStatus = RouteErrorStatus> = {
  status: TStatus;
  body: ReturnType<typeof errorBody>;
};

type UploadedFileInfo = {
  object: UploadedObject;
  filename: string;
  fileUrl: string;
};

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

function routeError<TStatus extends RouteErrorStatus>(
  status: TStatus,
  message: string,
  code: string,
): RouteErrorResponse<TStatus> {
  return {
    status,
    body: errorBody(message, code),
  };
}

function isRouteErrorResponse(result: unknown): result is RouteErrorResponse {
  return Boolean(result && typeof result === "object" && "status" in result);
}

async function resolveTelegramBotToken(
  orgId: string,
  botId: string,
): Promise<string | null> {
  if (isOfficialTelegramBotId(botId)) {
    return getOfficialTelegramBotConfig().botToken;
  }

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

  if (!row) return null;

  return decryptSecretValue(
    row.encryptedBotToken,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );
}

async function resolveUploadedObject(
  userId: string,
  uploadId: string,
): Promise<UploadedObject | null> {
  const bucket = env().R2_USER_ARTIFACTS_BUCKET_NAME;
  const prefix = buildArtifactPrefix(userId, uploadId);
  const objects = await listS3Objects(bucket, prefix);
  return objects[0] ?? null;
}

async function resolveUploadedFileInfo(
  userId: string,
  uploadId: string,
): Promise<UploadedFileInfo | RouteErrorResponse<404>> {
  const uploadedObject = await resolveUploadedObject(userId, uploadId);
  if (!uploadedObject) {
    return routeError(404, "Uploaded file not found", "NOT_FOUND");
  }

  const filename = uploadedObject.key.split("/").pop() ?? uploadId;
  return {
    object: uploadedObject,
    filename,
    fileUrl: buildFileUrl(userId, uploadId, filename),
  };
}

function buildTelegramUploadMetadata(params: {
  body: TelegramUploadCompleteBody;
  uploadId: string;
  sourceUrl: string;
  telegramMessageId: number;
  telegramFileId: string | undefined;
}): Record<string, unknown> {
  const { body, uploadId, sourceUrl, telegramMessageId, telegramFileId } =
    params;
  return {
    botId: body.botId,
    chatId: body.chatId,
    uploadId,
    sourceUrl,
    ...(body.caption ? { caption: body.caption } : {}),
    ...(body.messageThreadId ? { messageThreadId: body.messageThreadId } : {}),
    telegramMessage: {
      id: telegramMessageId,
      ...(telegramFileId ? { fileId: telegramFileId } : {}),
    },
  };
}

async function sendAndRecordTelegramDocument(params: {
  body: TelegramUploadCompleteBody;
  botToken: string;
  userId: string;
  orgId: string;
  runId: string | undefined;
  uploadedFile: UploadedFileInfo;
}): Promise<TelegramUploadCompleteResponse | RouteErrorResponse<400 | 502>> {
  const { body, botToken, userId, orgId, runId, uploadedFile } = params;
  const client = createTelegramClient(botToken);

  try {
    const sentMessage = await sendDocument(
      client,
      body.chatId,
      uploadedFile.fileUrl,
      {
        caption: body.caption,
        messageThreadId: body.messageThreadId,
      },
    );
    const document = sentMessage.document;
    const mimetype =
      document?.mime_type ??
      body.contentType ??
      inferMimetype(uploadedFile.filename);
    const size = document?.file_size ?? uploadedFile.object.size;
    const fileId = document?.file_id;

    await recordRunUploadedFile({
      runId,
      source: "telegram",
      externalId: fileId ?? `${body.chatId}:${sentMessage.message_id}`,
      userId,
      orgId,
      filename: document?.file_name ?? uploadedFile.filename,
      contentType: mimetype,
      sizeBytes: size,
      url: uploadedFile.fileUrl,
      metadata: buildTelegramUploadMetadata({
        body,
        uploadId: body.uploadId,
        sourceUrl: uploadedFile.fileUrl,
        telegramMessageId: sentMessage.message_id,
        telegramFileId: fileId,
      }),
    });

    return {
      messageId: sentMessage.message_id,
      chatId: String(sentMessage.chat.id),
      fileId,
      filename: document?.file_name ?? uploadedFile.filename,
      mimetype,
      size,
      url: uploadedFile.fileUrl,
    };
  } catch (error) {
    if (isTelegramApiError(error)) {
      const message = `Telegram API error: ${error.description ?? `HTTP ${error.status}`}`;
      return routeError(
        error.status >= 500 ? 502 : 400,
        message,
        "TELEGRAM_ERROR",
      );
    }
    throw error;
  }
}

const router = tsr.router(integrationsTelegramUploadCompleteContract, {
  complete: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "telegram:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    if (!authCtx.orgId) {
      return {
        status: 403 as const,
        body: errorBody("Organization context is required", "FORBIDDEN"),
      };
    }

    const botToken = await resolveTelegramBotToken(authCtx.orgId, body.botId);
    if (!botToken) {
      return routeError(404, "Telegram bot not found", "NOT_FOUND");
    }

    const uploadedFile = await resolveUploadedFileInfo(
      authCtx.userId,
      body.uploadId,
    );
    if (isRouteErrorResponse(uploadedFile)) return uploadedFile;

    const result = await sendAndRecordTelegramDocument({
      body,
      botToken,
      userId: authCtx.userId,
      orgId: authCtx.orgId,
      runId: authCtx.runId,
      uploadedFile,
    });
    if (isRouteErrorResponse(result)) return result;

    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(
  integrationsTelegramUploadCompleteContract,
  router,
  {
    routeName: "zero.integrations.telegram.upload-file.complete",
  },
);

export { handler as POST };
