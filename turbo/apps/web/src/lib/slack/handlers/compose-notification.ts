import { eq } from "drizzle-orm";
import { slackComposeRequests } from "../../../db/schema/slack-compose-request";
import { slackInstallations } from "../../../db/schema/slack-installation";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { createSlackClient } from "../client";
import { env } from "../../../env";
import { logger } from "../../logger";
import type { ComposeJobResult } from "../../../db/schema/compose-job";

const log = logger("slack:compose-notification");

/**
 * Notify Slack user when a compose job completes.
 * Only sends a notification if the job was initiated from Slack (has a slack_compose_requests record).
 */
export async function notifySlackComposeComplete(
  jobId: string,
  result: ComposeJobResult | null,
  error: string | null,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  // Look up Slack context for this compose job
  const [request] = await globalThis.services.db
    .select()
    .from(slackComposeRequests)
    .where(eq(slackComposeRequests.composeJobId, jobId))
    .limit(1);

  if (!request) {
    // Not a Slack-initiated job, nothing to do
    return;
  }

  // Look up bot token for the workspace
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, request.slackWorkspaceId))
    .limit(1);

  if (!installation) {
    log.warn(
      `No Slack installation found for workspace ${request.slackWorkspaceId}`,
    );
    return;
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  if (result) {
    // Success notification
    await client.chat.postEphemeral({
      channel: request.slackChannelId,
      user: request.slackUserId,
      text: `Agent "${result.composeName}" composed successfully!`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:white_check_mark: *Agent \`${result.composeName}\` composed successfully!*\n\nRun \`/vm0 agent link\` to configure and link it.`,
          },
        },
      ],
    });
  } else {
    // Failure notification
    const errorMsg = error ?? "Unknown error";
    await client.chat.postEphemeral({
      channel: request.slackChannelId,
      user: request.slackUserId,
      text: `Failed to compose agent: ${errorMsg}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:x: *Failed to compose agent*\n\n${errorMsg}`,
          },
        },
      ],
    });
  }

  // Clean up the request record (one-time use)
  await globalThis.services.db
    .delete(slackComposeRequests)
    .where(eq(slackComposeRequests.id, request.id));
}
