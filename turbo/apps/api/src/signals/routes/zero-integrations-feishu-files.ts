import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  FEISHU_FILE_UPLOAD_MAX_BYTES,
  integrationsFeishuDownloadFileContract,
  integrationsFeishuUploadCompleteContract,
  integrationsFeishuUploadInitContract,
  type FeishuResourceType,
  type FeishuUploadCompleteBody,
} from "@vm0/api-contracts/contracts/integrations";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";

import { env } from "../../lib/env";
import {
  buildArtifactKey,
  buildArtifactPrefix,
  buildFileUrl,
  sanitizeArtifactFilename,
} from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import {
  downloadFeishuMessageResource,
  FeishuApiError,
  replyWithFeishuMessage,
  sendFeishuMessage,
  uploadFeishuFile,
  type FeishuOutboundMessage,
} from "../external/feishu-client";
import { writeDb$, type Db } from "../external/db";
import {
  downloadS3Buffer,
  generatePresignedPutUrl,
  listS3Objects,
} from "../external/s3";
import { feishuOrgCallbackPayloadSchema } from "../services/feishu-org-callback-payload";
import { recordFeishuUploadedFile$ } from "../services/run-uploaded-files.service";
import type { RouteEntry } from "../route-entry";
import { safeUriComponentDecode, settle } from "../utils";

const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const PUT_URL_TTL_SECONDS = 3600;
const FEISHU_FILE_ID_PREFIX = "feishu_file_";

type InstallationResolution =
  | { readonly kind: "resolved"; readonly id: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous" };

interface FeishuDownloadTarget {
  readonly installationId: string | undefined;
  readonly messageId: string;
  readonly fileKey: string;
  readonly type: FeishuResourceType;
}

function apiError(
  status: 400 | 404 | 413 | 502,
  code:
    | "BAD_REQUEST"
    | "EMPTY_BODY"
    | "FEISHU_ERROR"
    | "NOT_FOUND"
    | "PAYLOAD_TOO_LARGE",
  message: string,
) {
  return {
    status,
    body: { error: { code, message } },
  } as const;
}

async function resolveInstallation(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly installationId: string | undefined;
  readonly signal: AbortSignal;
}): Promise<InstallationResolution> {
  const installations = await args.db
    .select({ id: feishuOrgInstallations.id })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.orgId, args.orgId),
        isNotNull(feishuOrgInstallations.setupCompletedAt),
        ...(args.installationId
          ? [eq(feishuOrgInstallations.id, args.installationId)]
          : []),
      ),
    )
    .limit(2);
  args.signal.throwIfAborted();
  const installation = installations[0];
  if (!installation) {
    return { kind: "not_found" };
  }
  if (!args.installationId && installations.length > 1) {
    return { kind: "ambiguous" };
  }
  return { kind: "resolved", id: installation.id };
}

async function resolveDownloadTarget(args: {
  readonly db: Db;
  readonly runId: string | undefined;
  readonly installationId: string | undefined;
  readonly messageId: string;
  readonly fileKey: string;
  readonly type: FeishuResourceType;
}): Promise<FeishuDownloadTarget | null> {
  if (!args.fileKey.startsWith(FEISHU_FILE_ID_PREFIX)) {
    return {
      installationId: args.installationId,
      messageId: args.messageId,
      fileKey: args.fileKey,
      type: args.type,
    };
  }
  if (!args.runId) {
    return null;
  }
  const [callback] = await args.db
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "feishu:org"),
      ),
    )
    .limit(1);
  const parsed = feishuOrgCallbackPayloadSchema.safeParse(callback?.payload);
  if (!parsed.success) {
    return null;
  }
  const file = parsed.data.files?.find((candidate) => {
    return candidate.fileId === args.fileKey;
  });
  return file
    ? {
        installationId: parsed.data.installationId,
        messageId: file.messageId,
        fileKey: file.fileKey,
        type: file.type,
      }
    : null;
}

function installationError(
  resolution: Exclude<InstallationResolution, { readonly kind: "resolved" }>,
  installationId: string | undefined,
) {
  if (resolution.kind === "ambiguous") {
    return apiError(
      400,
      "BAD_REQUEST",
      "Multiple Feishu installations are available. Specify installationId.",
    );
  }
  return apiError(
    404,
    "NOT_FOUND",
    installationId
      ? "Feishu installation not found"
      : "No Feishu installation found for this organization",
  );
}

function feishuApiError(error: FeishuApiError) {
  return apiError(
    error.routeStatus,
    "FEISHU_ERROR",
    `Feishu API error: ${error.message}`,
  );
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/iu);
  if (utf8Match?.[1]) {
    return safeUriComponentDecode(utf8Match[1].trim()) ?? utf8Match[1].trim();
  }
  return value.match(/filename="([^"]+)"/iu)?.[1] ?? null;
}

function sanitizeDownloadFilename(filename: string): string {
  return filename.trim().replace(/[/\\]/gu, "_").slice(0, 255) || "feishu-file";
}

function uploadMetadata(args: {
  readonly body: FeishuUploadCompleteBody;
  readonly installationId: string;
  readonly s3Key: string;
  readonly sourceUrl: string;
  readonly messageId: string;
  readonly chatId: string | null;
  readonly fileKey: string;
}): Record<string, unknown> {
  return {
    installationId: args.installationId,
    uploadId: args.body.uploadId,
    s3Key: args.s3Key,
    sourceUrl: args.sourceUrl,
    ...(args.body.chat ? { chat: args.body.chat } : {}),
    ...(args.body.user ? { user: args.body.user } : {}),
    ...(args.body.replyToMessageId
      ? { replyToMessageId: args.body.replyToMessageId }
      : {}),
    ...(args.body.replyInThread ? { replyInThread: true } : {}),
    feishuMessage: {
      messageId: args.messageId,
      chatId: args.chatId,
      fileKey: args.fileKey,
    },
  };
}

async function resolveUserOpenId(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly userId: string;
  readonly requestedOpenId: string | undefined;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly kind: "resolved"; readonly openId: string | undefined }
  | { readonly kind: "not_found" }
> {
  if (args.requestedOpenId !== "me") {
    return { kind: "resolved", openId: args.requestedOpenId };
  }
  const [connection] = await args.db
    .select({ openId: feishuOrgConnections.feishuOpenId })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, args.installationId),
        eq(feishuOrgConnections.vm0UserId, args.userId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return connection
    ? { kind: "resolved", openId: connection.openId }
    : { kind: "not_found" };
}

function deliverUploadedFile(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly body: FeishuUploadCompleteBody;
  readonly userOpenId: string | undefined;
  readonly fileKey: string;
  readonly signal: AbortSignal;
}): ReturnType<typeof sendFeishuMessage> | null {
  const message: FeishuOutboundMessage = {
    msgType: "file",
    content: { file_key: args.fileKey },
  };
  if (args.body.replyToMessageId) {
    return replyWithFeishuMessage({
      db: args.db,
      installationId: args.installationId,
      messageId: args.body.replyToMessageId,
      message,
      replyInThread: args.body.replyInThread,
      signal: args.signal,
    });
  }
  const receiveId = args.userOpenId ?? args.body.chat;
  if (!receiveId) {
    return null;
  }
  return sendFeishuMessage({
    db: args.db,
    installationId: args.installationId,
    receiveIdType: args.userOpenId ? "open_id" : "chat_id",
    receiveId,
    message,
    signal: args.signal,
  });
}

const download$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(integrationsFeishuDownloadFileContract.download));
  const db = set(writeDb$);
  const target = await resolveDownloadTarget({
    db,
    runId: "runId" in auth ? auth.runId : undefined,
    installationId: query.installation_id,
    messageId: query.message_id,
    fileKey: query.file_key,
    type: query.type,
  });
  signal.throwIfAborted();
  if (!target) {
    return apiError(400, "BAD_REQUEST", "Invalid Feishu file id");
  }
  const installation = await resolveInstallation({
    db,
    orgId: auth.orgId,
    installationId: target.installationId,
    signal,
  });
  if (installation.kind !== "resolved") {
    return installationError(installation, target.installationId);
  }

  const downloaded = await settle(
    downloadFeishuMessageResource({
      db,
      installationId: installation.id,
      messageId: target.messageId,
      fileKey: target.fileKey,
      resourceType: target.type,
      signal,
    }),
    signal,
  );
  if (!downloaded.ok) {
    if (downloaded.error instanceof FeishuApiError) {
      return feishuApiError(downloaded.error);
    }
    throw downloaded.error;
  }
  if (!downloaded.value.body) {
    return apiError(502, "EMPTY_BODY", "Feishu download response has no body");
  }

  const contentLength = downloaded.value.headers.get("content-length");
  const size = parseContentLength(contentLength);
  if (size !== undefined && size > DOWNLOAD_MAX_BYTES) {
    return apiError(
      413,
      "PAYLOAD_TOO_LARGE",
      `File exceeds maximum size of ${DOWNLOAD_MAX_BYTES} bytes`,
    );
  }
  const filename = sanitizeDownloadFilename(
    filenameFromContentDisposition(
      downloaded.value.headers.get("content-disposition"),
    ) ?? `feishu-${target.fileKey}`,
  );
  const contentType =
    downloaded.value.headers.get("content-type") ?? inferMimetype(filename);
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("X-File-Name", encodeURIComponent(filename));
  headers.set("X-File-Mimetype", contentType);
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }
  return new Response(downloaded.value.body, { status: 200, headers });
});

const initUpload$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsFeishuUploadInitContract.init),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const uploadId = crypto.randomUUID();
  const filename = sanitizeArtifactFilename(bodyResult.data.filename);
  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const key = buildArtifactKey(auth.userId, uploadId, filename);
  const uploadUrl = await get(
    generatePresignedPutUrl(
      bucket,
      key,
      bodyResult.data.contentType,
      PUT_URL_TTL_SECONDS,
      true,
    ),
  );
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      uploadId,
      uploadUrl,
      fileUrl: buildFileUrl(auth.userId, uploadId, filename),
      filename,
      contentType: bodyResult.data.contentType,
      size: bodyResult.data.length,
    },
  };
});

const completeUpload$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;
  const bodyResult = await get(
    bodyResultOf(integrationsFeishuUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;
  const db = set(writeDb$);
  const installation = await resolveInstallation({
    db,
    orgId: auth.orgId,
    installationId: body.installationId,
    signal,
  });
  if (installation.kind !== "resolved") {
    return installationError(installation, body.installationId);
  }

  const user = await resolveUserOpenId({
    db,
    installationId: installation.id,
    userId: auth.userId,
    requestedOpenId: body.user,
    signal,
  });
  if (user.kind === "not_found") {
    return apiError(
      404,
      "NOT_FOUND",
      "No Feishu connection found for the current user",
    );
  }

  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const prefix = buildArtifactPrefix(auth.userId, body.uploadId);
  const objects = await get(listS3Objects(bucket, prefix));
  signal.throwIfAborted();
  const object = objects[0];
  if (!object) {
    return apiError(404, "NOT_FOUND", "Uploaded file not found");
  }
  if (object.size > FEISHU_FILE_UPLOAD_MAX_BYTES) {
    return apiError(
      413,
      "PAYLOAD_TOO_LARGE",
      `File exceeds maximum size of ${FEISHU_FILE_UPLOAD_MAX_BYTES} bytes`,
    );
  }

  const filename = object.key.split("/").pop() ?? body.uploadId;
  const contentType = body.contentType ?? inferMimetype(filename);
  const fileUrl = buildFileUrl(auth.userId, body.uploadId, filename);
  const content = await get(downloadS3Buffer(bucket, object.key));
  signal.throwIfAborted();
  const uploaded = await settle(
    uploadFeishuFile({
      db,
      installationId: installation.id,
      filename,
      contentType,
      content,
      signal,
    }),
    signal,
  );
  if (!uploaded.ok) {
    if (uploaded.error instanceof FeishuApiError) {
      return feishuApiError(uploaded.error);
    }
    throw uploaded.error;
  }

  const delivery = deliverUploadedFile({
    db,
    installationId: installation.id,
    body,
    userOpenId: user.openId,
    fileKey: uploaded.value,
    signal,
  });
  if (!delivery) {
    return apiError(400, "BAD_REQUEST", "A Feishu file target is required");
  }

  const sent = await settle(delivery, signal);
  if (!sent.ok) {
    if (sent.error instanceof FeishuApiError) {
      return feishuApiError(sent.error);
    }
    throw sent.error;
  }
  await set(
    recordFeishuUploadedFile$,
    {
      runId,
      externalId: sent.value.messageId,
      userId: auth.userId,
      orgId: auth.orgId,
      filename,
      contentType,
      sizeBytes: object.size,
      url: fileUrl,
      metadata: uploadMetadata({
        body,
        installationId: installation.id,
        s3Key: object.key,
        sourceUrl: fileUrl,
        messageId: sent.value.messageId,
        chatId: sent.value.chatId,
        fileKey: uploaded.value,
      }),
    },
    signal,
  );
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      messageId: sent.value.messageId,
      chatId: sent.value.chatId,
      fileKey: uploaded.value,
      filename,
      mimetype: contentType,
      size: object.size,
      url: fileUrl,
    },
  };
});

const feishuWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "feishu:write",
} as const;

export const zeroIntegrationsFeishuFileRoutes: readonly RouteEntry[] = [
  {
    route: integrationsFeishuDownloadFileContract.download,
    handler: authRoute(feishuWriteAuth, download$),
  },
  {
    route: integrationsFeishuUploadInitContract.init,
    handler: authRoute(feishuWriteAuth, initUpload$),
  },
  {
    route: integrationsFeishuUploadCompleteContract.complete,
    handler: authRoute(feishuWriteAuth, completeUpload$),
  },
];
