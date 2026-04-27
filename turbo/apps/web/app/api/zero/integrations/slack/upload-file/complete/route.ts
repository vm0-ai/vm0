import {
  createHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { integrationsSlackUploadCompleteContract } from "@vm0/api-contracts/contracts/integrations";
import { initServices } from "../../../../../../../src/lib/init-services";
import { isSlackPlatformError } from "../../../../../../../src/lib/zero/slack/client";
import {
  resolveSlackClient,
  isSlackClientError,
} from "../../../../../../../src/lib/zero/slack/resolve-slack-client";
import { recordRunUploadedFile } from "../../../../../../../src/lib/zero/uploads/run-uploaded-files";
import type { SlackUploadCompleteBody } from "@vm0/api-contracts/contracts/integrations";

type SlackUploadFileInfo = {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  permalink?: string;
};

function buildSlackUploadMetadata(
  body: SlackUploadCompleteBody,
  file: SlackUploadFileInfo | undefined,
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

async function recordCompletedSlackUpload(params: {
  runId: string | undefined;
  userId: string;
  orgId: string;
  body: SlackUploadCompleteBody;
  file: SlackUploadFileInfo | undefined;
  permalink: string;
}): Promise<void> {
  const { runId, userId, orgId, body, file, permalink } = params;
  await recordRunUploadedFile({
    runId,
    source: "slack",
    externalId: body.fileId,
    userId,
    orgId,
    filename: body.title ?? file?.title ?? file?.name ?? null,
    contentType: file?.mimetype ?? null,
    sizeBytes: file?.size ?? null,
    url: permalink || null,
    metadata: buildSlackUploadMetadata(body, file),
  });
}

const router = tsr.router(integrationsSlackUploadCompleteContract, {
  complete: async ({ body, headers }) => {
    initServices();

    const slackCtx = await resolveSlackClient(
      headers.authorization,
      "slack:write",
    );
    if (isSlackClientError(slackCtx)) return slackCtx;

    try {
      await slackCtx.client.files.completeUploadExternal({
        files: [{ id: body.fileId, title: body.title }],
        channel_id: body.channel,
        thread_ts: body.threadTs,
        initial_comment: body.initialComment,
      });

      // completeUploadExternal returns minimal data — fetch full file info for permalink
      const fileInfo = await slackCtx.client.files.info({ file: body.fileId });
      const file = fileInfo.file as SlackUploadFileInfo | undefined;
      const permalink = file?.permalink ?? "";

      await recordCompletedSlackUpload({
        runId: slackCtx.authRunId,
        userId: slackCtx.userId,
        orgId: slackCtx.orgId,
        body,
        file,
        permalink,
      });

      return {
        status: 200 as const,
        body: {
          fileId: body.fileId,
          permalink,
        },
      };
    } catch (error) {
      if (isSlackPlatformError(error)) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Slack API error: ${error.data.error}`,
              code: "SLACK_ERROR",
            },
          },
        };
      }
      throw error;
    }
  },
});

const handler = createHandler(integrationsSlackUploadCompleteContract, router, {
  routeName: "zero.integrations.slack.upload-file.complete",
});

export { handler as POST };
