import { command } from "ccstate";
import {
  integrationsPhoneUploadCompleteContract,
  type PhoneUploadCompleteBody,
} from "@vm0/api-contracts/contracts/integrations";

import { env } from "../../lib/env";
import { buildArtifactPrefix, buildFileUrl } from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { listS3Objects } from "../external/s3";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import { recordAgentPhoneUploadedFile$ } from "../services/run-uploaded-files.service";
import {
  normalizeAgentPhoneHandle,
  resolveAgentPhoneAgentIdForUserLink,
  resolveAgentPhoneUserLinkForOwner,
  storeOutboundAgentPhoneMessage,
  type AgentPhoneChannel,
} from "../services/zero-agentphone.service";
import type { RouteEntry } from "../route";
import { settle } from "../utils";

interface UploadedFileInfo {
  readonly key: string;
  readonly size: number;
  readonly filename: string;
  readonly fileUrl: string;
}

function routeError<Status extends 400 | 401 | 403 | 404 | 502>(
  status: Status,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
}

function uploadedFileNotFound() {
  return routeError(404, "Uploaded file not found", "NOT_FOUND");
}

function agentPhoneRouteError(error: unknown) {
  if (!isAgentPhoneApiError(error)) {
    return undefined;
  }
  return routeError(
    error.status >= 500 ? 502 : 400,
    `AgentPhone API error: ${error.body || `HTTP ${error.status}`}`,
    "AGENTPHONE_ERROR",
  );
}

function buildMetadata(params: {
  readonly body: PhoneUploadCompleteBody;
  readonly uploadId: string;
  readonly s3Key: string;
  readonly sourceUrl: string;
  readonly agentphoneMessageId: string;
}): Record<string, unknown> {
  return {
    toNumber: normalizeAgentPhoneHandle(params.body.toNumber, "sms"),
    uploadId: params.uploadId,
    s3Key: params.s3Key,
    sourceUrl: params.sourceUrl,
    ...(params.body.caption ? { caption: params.body.caption } : {}),
    agentphoneMessage: { id: params.agentphoneMessageId },
  };
}

const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;
  const bodyResult = await get(
    bodyResultOf(integrationsPhoneUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const prefix = buildArtifactPrefix(auth.userId, body.uploadId);
  const objects = await get(listS3Objects(bucket, prefix));
  signal.throwIfAborted();
  const object = objects[0];
  if (!object) {
    return uploadedFileNotFound();
  }

  const filename = object.key.split("/").pop() ?? body.uploadId;
  const uploadedFile: UploadedFileInfo = {
    key: object.key,
    size: object.size,
    filename,
    fileUrl: buildFileUrl(auth.userId, body.uploadId, filename),
  };

  const userChannel: AgentPhoneChannel = "sms";
  const phoneHandle = normalizeAgentPhoneHandle(body.toNumber, userChannel);
  const db = set(writeDb$);
  const userLink = await resolveAgentPhoneUserLinkForOwner(db, {
    phoneHandle,
    channel: userChannel,
    vm0UserId: auth.userId,
    orgId: auth.orgId,
  });
  signal.throwIfAborted();
  if (!userLink) {
    return routeError(404, "Connected phone handle not found", "NOT_FOUND");
  }

  const agentphoneAgentId = await resolveAgentPhoneAgentIdForUserLink(db, {
    userLinkId: userLink.id,
    phoneHandle,
    channel: userChannel,
    agentphoneAgentId: body.agentphoneAgentId,
  });
  signal.throwIfAborted();
  if (!agentphoneAgentId) {
    return routeError(404, "AgentPhone agent not found", "NOT_FOUND");
  }

  const mimetype = body.contentType ?? inferMimetype(uploadedFile.filename);
  const sendResult = await settle(
    sendAgentPhoneMessage(
      {
        agentphoneAgentId,
        toNumber: phoneHandle,
        body: body.caption ?? "",
        mediaUrl: uploadedFile.fileUrl,
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!sendResult.ok) {
    const routeErr = agentPhoneRouteError(sendResult.error);
    if (routeErr) {
      return routeErr;
    }
    throw sendResult.error;
  }
  const sent = sendResult.value;

  await set(
    recordAgentPhoneUploadedFile$,
    {
      runId,
      externalId: sent.id,
      userId: auth.userId,
      orgId: auth.orgId,
      filename: uploadedFile.filename,
      contentType: mimetype,
      sizeBytes: uploadedFile.size,
      url: uploadedFile.fileUrl,
      metadata: buildMetadata({
        body,
        uploadId: body.uploadId,
        s3Key: uploadedFile.key,
        sourceUrl: uploadedFile.fileUrl,
        agentphoneMessageId: sent.id,
      }),
    },
    signal,
  );
  signal.throwIfAborted();

  await storeOutboundAgentPhoneMessage(db, {
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
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      messageId: sent.id,
      channel: sent.channel,
      toNumber: sent.toNumber ?? phoneHandle,
      filename: uploadedFile.filename,
      mimetype,
      size: uploadedFile.size,
      url: uploadedFile.fileUrl,
    },
  };
});

const phoneWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "phone:write",
} as const;

export const zeroIntegrationsPhoneUploadCompleteRoutes: readonly RouteEntry[] =
  [
    {
      route: integrationsPhoneUploadCompleteContract.complete,
      handler: authRoute(phoneWriteAuth, complete$),
    },
  ];
