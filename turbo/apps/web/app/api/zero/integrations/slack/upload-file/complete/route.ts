import {
  createHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { integrationsSlackUploadCompleteContract } from "@vm0/core";
import { initServices } from "../../../../../../../src/lib/init-services";
import { isSlackPlatformError } from "../../../../../../../src/lib/zero/slack/client";
import {
  resolveSlackClient,
  isSlackClientError,
} from "../../../../../../../src/lib/zero/slack/resolve-slack-client";

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
      const permalink = fileInfo.file?.permalink ?? "";

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
