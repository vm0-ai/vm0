import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { integrationsSlackMessageContract } from "@vm0/core/contracts/integrations";
import { getModelDisplayName } from "@vm0/core/model-display-name";
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

/** Best-effort resolution of the selected model for the run. */
async function resolveSelectedModel(
  runId: string,
): Promise<string | undefined> {
  const [row] = await globalThis.services.db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.selectedModel ?? undefined;
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

/**
 * Resolve "me" to the current user's Slack user ID via org connections.
 * Returns null if no Slack connection is found.
 */
async function resolveCurrentUserSlackId(
  userId: string,
  orgId: string,
): Promise<string | null> {
  const [conn] = await globalThis.services.db
    .select({ slackUserId: slackOrgConnections.slackUserId })
    .from(slackOrgConnections)
    .innerJoin(
      slackOrgInstallations,
      eq(
        slackOrgConnections.slackWorkspaceId,
        slackOrgInstallations.slackWorkspaceId,
      ),
    )
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, userId),
        eq(slackOrgInstallations.orgId, orgId),
      ),
    )
    .limit(1);
  return conn?.slackUserId ?? null;
}

/** Resolve footer parts from the auth run context (best-effort, never throws). */
async function resolveFooterParts(
  authRunId: string | undefined,
): Promise<string[]> {
  if (!authRunId) return [];

  const [agentLabel, scheduleLabel, userMention, selectedModel] =
    await Promise.all([
      resolveAgentLabel(authRunId).catch(() => {
        return undefined;
      }),
      resolveScheduleLabel(authRunId).catch(() => {
        return undefined;
      }),
      resolveUserMention(authRunId).catch(() => {
        return undefined;
      }),
      resolveSelectedModel(authRunId).catch(() => {
        return undefined;
      }),
    ]);

  const parts: string[] = [];
  if (agentLabel) parts.push(`Sent via ${agentLabel}`);
  if (scheduleLabel) parts.push(`Triggered by schedule "${scheduleLabel}"`);
  if (userMention) {
    parts.push(
      scheduleLabel
        ? `Created by ${userMention}`
        : `Triggered by ${userMention}`,
    );
  }
  if (selectedModel) parts.push(getModelDisplayName(selectedModel));
  return parts;
}

const router = tsr.router(integrationsSlackMessageContract, {
  sendMessage: async ({ body, headers }) => {
    initServices();

    const slackCtx = await resolveSlackClient(
      headers.authorization,
      "slack:write",
    );
    if (isSlackClientError(slackCtx)) return slackCtx;

    const footerParts = await resolveFooterParts(slackCtx.authRunId);

    // Resolve target channel: DM via user ID or direct channel ID
    let targetChannel: string;
    if (body.user) {
      // Resolve "me" to the current user's Slack user ID
      let slackUserId = body.user;
      if (slackUserId === "me") {
        const resolved = await resolveCurrentUserSlackId(
          slackCtx.userId,
          slackCtx.orgId,
        );
        if (!resolved) {
          return {
            status: 404 as const,
            body: {
              error: {
                message:
                  "No Slack connection found for current user. Connect your Slack account first.",
                code: "NOT_FOUND",
              },
            },
          };
        }
        slackUserId = resolved;
      }

      try {
        targetChannel = await openDMChannel(slackCtx.client, slackUserId);
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

const handler = createHandler(integrationsSlackMessageContract, router, {
  routeName: "zero.integrations.slack.message",
});

export { handler as POST };
