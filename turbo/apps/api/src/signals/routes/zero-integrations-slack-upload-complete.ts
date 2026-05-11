import { command } from "ccstate";
import {
  integrationsSlackUploadCompleteContract,
  type SlackUploadCompleteBody,
} from "@vm0/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  completeUploadExternal,
  createSlackClient,
  getFileInfo,
  type SlackFileInfo,
} from "../external/slack-message-client";
import { recordSlackUploadedFile$ } from "../services/run-uploaded-files.service";
import { zeroSlackOrgInstallation } from "../services/zero-slack-data.service";
import type { RouteEntry } from "../route";

const noInstallation = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No Slack installation found for this organization",
      code: "NOT_FOUND",
    }),
  }),
});

function buildSlackUploadMetadata(
  body: SlackUploadCompleteBody,
  file: SlackFileInfo | undefined,
): Record<string, unknown> {
  return {
    channel: body.channel,
    ...(body.threadTs ? { threadTs: body.threadTs } : {}),
    ...(body.title ? { title: body.title } : {}),
    ...(body.initialComment ? { initialComment: body.initialComment } : {}),
    slackFile: {
      id: file?.id ?? body.fileId,
      name: file?.name ?? null,
      title: file?.title ?? null,
      mimetype: file?.mimetype ?? null,
      filetype: file?.filetype ?? null,
    },
  };
}

const completeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;

  const bodyResult = await get(
    bodyResultOf(integrationsSlackUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const installation = await get(
    zeroSlackOrgInstallation({ orgId: auth.orgId }),
  );
  signal.throwIfAborted();
  if (!installation) {
    return noInstallation;
  }

  const client = createSlackClient(installation.botToken);

  const completeResult = await completeUploadExternal(client, {
    fileId: body.fileId,
    channel: body.channel,
    threadTs: body.threadTs,
    title: body.title,
    initialComment: body.initialComment,
  });
  signal.throwIfAborted();
  if (completeResult.kind === "slack_error") {
    return {
      status: 400 as const,
      body: {
        error: {
          message: `Slack API error: ${completeResult.error}`,
          code: "SLACK_ERROR",
        },
      },
    };
  }

  const infoResult = await getFileInfo(client, body.fileId);
  signal.throwIfAborted();
  if (infoResult.kind === "slack_error") {
    return {
      status: 400 as const,
      body: {
        error: {
          message: `Slack API error: ${infoResult.error}`,
          code: "SLACK_ERROR",
        },
      },
    };
  }
  const file = infoResult.file;
  const permalink = file?.permalink ?? "";

  await set(
    recordSlackUploadedFile$,
    {
      runId,
      externalId: body.fileId,
      userId: auth.userId,
      orgId: auth.orgId,
      filename: body.title ?? file?.title ?? file?.name ?? null,
      contentType: file?.mimetype ?? null,
      sizeBytes: file?.size ?? null,
      url: permalink || null,
      metadata: buildSlackUploadMetadata(body, file),
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      fileId: body.fileId,
      permalink,
    },
  };
});

const slackWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "slack:write",
} as const;

export const zeroIntegrationsSlackUploadCompleteRoutes: readonly RouteEntry[] =
  [
    {
      route: integrationsSlackUploadCompleteContract.complete,
      handler: authRoute(slackWriteAuth, completeInner$),
    },
  ];
