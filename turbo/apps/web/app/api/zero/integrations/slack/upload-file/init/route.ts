import {
  createHandler,
  tsr,
} from "../../../../../../../src/lib/ts-rest-handler";
import { integrationsSlackUploadInitContract } from "@vm0/core/contracts/integrations";
import { initServices } from "../../../../../../../src/lib/init-services";
import { isSlackPlatformError } from "../../../../../../../src/lib/zero/slack/client";
import {
  resolveSlackClient,
  isSlackClientError,
} from "../../../../../../../src/lib/zero/slack/resolve-slack-client";

const router = tsr.router(integrationsSlackUploadInitContract, {
  init: async ({ body, headers }) => {
    initServices();

    const slackCtx = await resolveSlackClient(
      headers.authorization,
      "slack:write",
    );
    if (isSlackClientError(slackCtx)) return slackCtx;

    try {
      const result = await slackCtx.client.files.getUploadURLExternal({
        filename: body.filename,
        length: body.length,
      });

      if (!result.ok || !result.upload_url || !result.file_id) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Slack API error: ${result.error ?? "unknown error"}`,
              code: "SLACK_ERROR",
            },
          },
        };
      }

      return {
        status: 200 as const,
        body: {
          uploadUrl: result.upload_url,
          fileId: result.file_id,
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

const handler = createHandler(integrationsSlackUploadInitContract, router, {
  routeName: "zero.integrations.slack.upload-file.init",
});

export { handler as POST };
