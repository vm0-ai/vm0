import { eq } from "drizzle-orm";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentSchedules } from "../../../db/schema/agent-schedule";
import { agentComposes } from "../../../db/schema/agent-compose";
import { slackUserLinks } from "../../../db/schema/slack-user-link";
import { slackInstallations } from "../../../db/schema/slack-installation";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import { createSlackClient, postMessage } from "../client";
import { getRunOutput } from "./run-agent";
import { saveThreadSession, buildLogsUrl } from "./shared";
import { logger } from "../../logger";

const log = logger("slack:schedule-notification");

/**
 * Send a Slack DM notification when a scheduled agent run completes.
 * Creates a thread session so the user can reply in the DM thread to continue.
 */
export async function notifyScheduleRunComplete(
  runId: string,
  status: "completed" | "failed",
  errorMessage?: string,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();

  // 1. Get run to find scheduleId
  const [run] = await globalThis.services.db
    .select({
      scheduleId: agentRuns.scheduleId,
      result: agentRuns.result,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run?.scheduleId) return;

  // 2. Get schedule to find composeId
  const [schedule] = await globalThis.services.db
    .select({
      composeId: agentSchedules.composeId,
    })
    .from(agentSchedules)
    .where(eq(agentSchedules.id, run.scheduleId))
    .limit(1);

  if (!schedule) return;

  // 3. Get compose info (agent name + user)
  const [compose] = await globalThis.services.db
    .select({
      userId: agentComposes.userId,
      name: agentComposes.name,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, schedule.composeId))
    .limit(1);

  if (!compose) return;

  // 4. Find slack user link for this VM0 user
  const [userLink] = await globalThis.services.db
    .select({
      slackUserId: slackUserLinks.slackUserId,
      slackWorkspaceId: slackUserLinks.slackWorkspaceId,
    })
    .from(slackUserLinks)
    .where(eq(slackUserLinks.vm0UserId, compose.userId))
    .limit(1);

  if (!userLink) {
    log.debug("No Slack user link found, skipping notification", {
      userId: compose.userId,
    });
    return;
  }

  // 5. Get installation and decrypt bot token
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, userLink.slackWorkspaceId))
    .limit(1);

  if (!installation) {
    log.warn("No Slack installation found for workspace", {
      workspaceId: userLink.slackWorkspaceId,
    });
    return;
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  // 6. Build and send notification
  const logsUrl = buildLogsUrl(runId);

  if (status === "completed") {
    const output = await getRunOutput(runId);
    const truncatedOutput = output
      ? output.length > 2000
        ? `${output.slice(0, 2000)}…`
        : output
      : "Task completed successfully.";

    const { ts: messageTs, channel: dmChannelId } = await postMessage(
      client,
      userLink.slackUserId,
      `Scheduled run for "${compose.name}" completed`,
      {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:white_check_mark: *Scheduled run for \`${compose.name}\` completed*`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: truncatedOutput,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `<${logsUrl}|View logs> · Reply in this thread to continue the conversation`,
              },
            ],
          },
        ],
      },
    );

    // 7. Create thread session so user can reply to continue
    const result = run.result;
    const agentSessionId =
      result &&
      typeof result === "object" &&
      "agentSessionId" in result &&
      typeof result.agentSessionId === "string"
        ? result.agentSessionId
        : undefined;

    if (messageTs && dmChannelId && agentSessionId) {
      await saveThreadSession({
        bindingId: undefined,
        channelId: dmChannelId,
        threadTs: messageTs,
        existingSessionId: undefined,
        newSessionId: agentSessionId,
        messageTs,
        runStatus: "completed",
      });
    }
  } else {
    // Failed run
    const errMsg = errorMessage ?? "Unknown error";
    await postMessage(
      client,
      userLink.slackUserId,
      `Scheduled run for "${compose.name}" failed`,
      {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:x: *Scheduled run for \`${compose.name}\` failed*\n\n${errMsg}`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `<${logsUrl}|View logs>`,
              },
            ],
          },
        ],
      },
    );
  }

  log.info("Sent schedule notification", {
    runId,
    status,
    agentName: compose.name,
  });
}
