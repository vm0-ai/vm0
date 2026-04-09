import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { integrationsSlackMessageContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentComposeVersions } from "../../../../../../src/db/schema/agent-compose";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { zeroAgents } from "../../../../../../src/db/schema/zero-agent";
import { zeroRuns } from "../../../../../../src/db/schema/zero-run";
import { zeroAgentSchedules } from "../../../../../../src/db/schema/zero-agent-schedule";
import { slackOrgConnections } from "../../../../../../src/db/schema/slack-org-connection";
import { slackOrgInstallations } from "../../../../../../src/db/schema/slack-org-installation";
import {
  isSlackPlatformError,
  openDMChannel,
  postMessage,
} from "../../../../../../src/lib/zero/slack/client";
import {
  resolveSlackClient,
  isSlackClientError,
} from "../../../../../../src/lib/zero/slack/resolve-slack-client";
import { buildFooterBlocks } from "../../../../../../src/lib/zero/slack/blocks";
import type { Block, KnownBlock } from "@slack/web-api";
import { eq, and } from "drizzle-orm";

/** Best-effort agent display name resolution from a run ID. */
async function resolveAgentLabel(runId: string): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({
      displayName: zeroAgents.displayName,
      name: zeroAgents.name,
    })
    .from(agentRuns)
    .innerJoin(
      agentComposeVersions,
      eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
    )
    .innerJoin(zeroAgents, eq(agentComposeVersions.composeId, zeroAgents.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row?.displayName ?? row?.name;
}

/** Best-effort schedule description resolution from a run ID. */
async function resolveScheduleLabel(
  runId: string,
): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({ description: zeroAgentSchedules.description })
    .from(zeroRuns)
    .innerJoin(
      zeroAgentSchedules,
      eq(zeroRuns.scheduleId, zeroAgentSchedules.id),
    )
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.description ?? undefined;
}

/** Best-effort resolution of the Slack user mention for the run owner. */
async function resolveUserMention(runId: string): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({ slackUserId: slackOrgConnections.slackUserId })
    .from(agentRuns)
    .innerJoin(
      slackOrgInstallations,
      eq(slackOrgInstallations.orgId, agentRuns.orgId),
    )
    .innerJoin(
      slackOrgConnections,
      and(
        eq(slackOrgConnections.vm0UserId, agentRuns.userId),
        eq(
          slackOrgConnections.slackWorkspaceId,
          slackOrgInstallations.slackWorkspaceId,
        ),
      ),
    )
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return row ? `<@${row.slackUserId}>` : undefined;
}

const router = tsr.router(integrationsSlackMessageContract, {
  sendMessage: async ({ body, headers }) => {
    initServices();

    const slackCtx = await resolveSlackClient(
      headers.authorization,
      "slack:write",
    );
    if (isSlackClientError(slackCtx)) return slackCtx;

    // Resolve agent name and schedule context for footer (best-effort)
    const agentLabel = slackCtx.authRunId
      ? await resolveAgentLabel(slackCtx.authRunId).catch(() => {
          return undefined;
        })
      : undefined;
    const scheduleLabel = slackCtx.authRunId
      ? await resolveScheduleLabel(slackCtx.authRunId).catch(() => {
          return undefined;
        })
      : undefined;

    // Resolve user mention for footer attribution (best-effort)
    const userMention = slackCtx.authRunId
      ? await resolveUserMention(slackCtx.authRunId).catch(() => {
          return undefined;
        })
      : undefined;

    // Build combined footer text from available context
    const footerParts: string[] = [];
    if (agentLabel) footerParts.push(`Sent via ${agentLabel}`);
    if (scheduleLabel)
      footerParts.push(`Triggered by schedule "${scheduleLabel}"`);
    if (userMention) {
      footerParts.push(
        scheduleLabel
          ? `Created by ${userMention}`
          : `Triggered by ${userMention}`,
      );
    }

    // Resolve target channel: DM via user ID or direct channel ID
    let targetChannel: string;
    if (body.user) {
      try {
        targetChannel = await openDMChannel(slackCtx.client, body.user);
      } catch (error) {
        if (isSlackPlatformError(error)) {
          return {
            status: 404 as const,
            body: {
              error: {
                message: `Cannot open DM: ${error.data.error}`,
                code: "NOT_FOUND",
              },
            },
          };
        }
        throw error;
      }
    } else {
      targetChannel = body.channel!;
    }

    let finalBlocks = body.blocks as (Block | KnownBlock)[] | undefined;
    if (footerParts.length > 0) {
      const footerBlocks = buildFooterBlocks(footerParts.join(" · "));
      if (finalBlocks && finalBlocks.length > 0) {
        finalBlocks = [...finalBlocks, ...footerBlocks];
      } else if (body.text) {
        // Text-only message — wrap text in a section block so Slack renders it
        // (when blocks are present, Slack ignores the text field for display)
        finalBlocks = [
          { type: "section", text: { type: "mrkdwn", text: body.text } },
          ...footerBlocks,
        ];
      } else {
        finalBlocks = footerBlocks;
      }
    }

    try {
      const result = await postMessage(
        slackCtx.client,
        targetChannel,
        body.text ?? "",
        {
          threadTs: body.threadTs,
          blocks: finalBlocks,
        },
      );
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          ts: result.ts,
          channel: result.channel,
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

const handler = createHandler(integrationsSlackMessageContract, router);

export { handler as POST };
