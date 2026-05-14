import {
  createHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { integrationsPhoneUploadCompleteContract } from "@vm0/api-contracts/contracts/integrations";
import { initServices } from "../../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../../src/lib/auth/require-auth";
import { listS3Objects } from "../../../../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../../../../src/env";
import { buildFileUrl } from "../../../../../../../src/lib/zero/uploads/file-url";
import { recordRunUploadedFile } from "../../../../../../../src/lib/zero/uploads/run-uploaded-files";
import { inferMimetype } from "../../../../../../../src/lib/shared/mimetype";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../../../../../../../src/lib/zero/agentphone/client";
import {
  normalizeAgentPhoneHandle,
  resolveAgentPhoneAgentIdForUserLink,
  resolveAgentPhoneUserLinkForOwner,
  storeOutboundAgentPhoneMessage,
  type AgentPhoneChannel,
} from "../../../../../../../src/lib/zero/agentphone/shared";
import type {
  PhoneUploadCompleteBody,
  PhoneUploadCompleteResponse,
} from "@vm0/api-contracts/contracts/integrations";

type UploadedObject = {
  key: string;
  size: number;
};

type RouteErrorStatus = 400 | 401 | 403 | 404 | 502;

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
  return { status, body: errorBody(message, code) };
}

function isRouteErrorResponse(result: unknown): result is RouteErrorResponse {
  return Boolean(result && typeof result === "object" && "status" in result);
}

function agentPhoneRouteError(
  error: unknown,
): RouteErrorResponse<400 | 502> | undefined {
  if (!isAgentPhoneApiError(error)) return undefined;
  return routeError(
    error.status >= 500 ? 502 : 400,
    `AgentPhone API error: ${error.body || `HTTP ${error.status}`}`,
    "AGENTPHONE_ERROR",
  );
}

async function resolveUploadedObject(
  userId: string,
  uploadId: string,
): Promise<UploadedObject | null> {
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
  const prefix = `uploads/${userId}/${uploadId}/`;
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

function buildAgentPhoneUploadMetadata(params: {
  body: PhoneUploadCompleteBody;
  uploadId: string;
  sourceUrl: string;
  agentphoneMessageId: string;
}): Record<string, unknown> {
  const { body, uploadId, sourceUrl, agentphoneMessageId } = params;
  return {
    toNumber: normalizeAgentPhoneHandle(body.toNumber, "sms"),
    uploadId,
    sourceUrl,
    ...(body.caption ? { caption: body.caption } : {}),
    agentphoneMessage: {
      id: agentphoneMessageId,
    },
  };
}

async function sendAndRecordAgentPhoneFile(params: {
  body: PhoneUploadCompleteBody;
  userId: string;
  orgId: string;
  runId: string | undefined;
  uploadedFile: UploadedFileInfo;
}): Promise<PhoneUploadCompleteResponse | RouteErrorResponse> {
  const { body, userId, orgId, runId, uploadedFile } = params;
  const userChannel: AgentPhoneChannel = "sms";
  const phoneHandle = normalizeAgentPhoneHandle(body.toNumber, userChannel);
  const userLink = await resolveAgentPhoneUserLinkForOwner({
    phoneHandle,
    channel: userChannel,
    vm0UserId: userId,
    orgId,
  });
  if (!userLink) {
    return routeError(404, "Connected phone handle not found", "NOT_FOUND");
  }

  const agentphoneAgentId = await resolveAgentPhoneAgentIdForUserLink({
    userLinkId: userLink.id,
    phoneHandle,
    channel: userChannel,
    agentphoneAgentId: body.agentphoneAgentId,
  });
  if (!agentphoneAgentId) {
    return routeError(404, "AgentPhone agent not found", "NOT_FOUND");
  }

  const mimetype = body.contentType ?? inferMimetype(uploadedFile.filename);
  try {
    const sent = await sendAgentPhoneMessage({
      agentphoneAgentId,
      toNumber: phoneHandle,
      body: body.caption ?? "",
      mediaUrl: uploadedFile.fileUrl,
    });

    await recordRunUploadedFile({
      runId,
      source: "agentphone",
      externalId: sent.id,
      userId,
      orgId,
      filename: uploadedFile.filename,
      contentType: mimetype,
      sizeBytes: uploadedFile.object.size,
      url: uploadedFile.fileUrl,
      metadata: buildAgentPhoneUploadMetadata({
        body,
        uploadId: body.uploadId,
        sourceUrl: uploadedFile.fileUrl,
        agentphoneMessageId: sent.id,
      }),
    });

    await storeOutboundAgentPhoneMessage({
      agentphoneMessageId: sent.id,
      conversationId: null,
      agentphoneAgentId,
      userLinkId: userLink.id,
      phoneHandle,
      fromNumber: sent.fromNumber ?? "",
      toNumber: sent.toNumber ?? phoneHandle,
      body: body.caption,
      channel: sent.channel,
      userChannel,
      mediaUrl: uploadedFile.fileUrl,
    });

    return {
      messageId: sent.id,
      channel: sent.channel,
      toNumber: sent.toNumber ?? phoneHandle,
      filename: uploadedFile.filename,
      mimetype,
      size: uploadedFile.object.size,
      url: uploadedFile.fileUrl,
    };
  } catch (error) {
    const routeErr = agentPhoneRouteError(error);
    if (routeErr) return routeErr;
    throw error;
  }
}

const router = tsr.router(integrationsPhoneUploadCompleteContract, {
  complete: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "phone:write",
    });
    if (isAuthError(authCtx)) return authCtx;

    if (!authCtx.orgId) {
      return routeError(401, "Not authenticated", "UNAUTHORIZED");
    }

    const uploadedFile = await resolveUploadedFileInfo(
      authCtx.userId,
      body.uploadId,
    );
    if (isRouteErrorResponse(uploadedFile)) return uploadedFile;

    const result = await sendAndRecordAgentPhoneFile({
      body,
      userId: authCtx.userId,
      orgId: authCtx.orgId,
      runId: authCtx.runId,
      uploadedFile,
    });
    if (isRouteErrorResponse(result)) return result;

    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(integrationsPhoneUploadCompleteContract, router, {
  routeName: "zero.integrations.phone.upload-file.complete",
});

export { handler as POST };
