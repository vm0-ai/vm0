import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { integrationsSlackMessageContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentComposeVersions } from "../../../../../../src/db/schema/agent-compose";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { zeroAgents } from "../../../../../../src/db/schema/zero-agent";
import {
  isSlackPlatformError,
  postMessage,
} from "../../../../../../src/lib/slack/client";
import {
  resolveSlackClient,
  isSlackClientError,
} from "../../../../../../src/lib/slack/resolve-slack-client";
import { buildFooterBlocks } from "../../../../../../src/lib/slack/blocks";
import type { Block, KnownBlock } from "@slack/web-api";
import { eq } from "drizzle-orm";

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

const router = tsr.router(integrationsSlackMessageContract, {
  sendMessage: async ({ body, headers }) => {
    initServices();

    const slackCtx = await resolveSlackClient(
      headers.authorization,
      "slack:write",
    );
    if (isSlackClientError(slackCtx)) return slackCtx;

    // Resolve agent name for "Sent via" footer (best-effort)
    const agentLabel = slackCtx.authRunId
      ? await resolveAgentLabel(slackCtx.authRunId).catch(() => {
          return undefined;
        })
      : undefined;

    // Append "Sent via <agent>" footer blocks when agent is known
    let finalBlocks = body.blocks as (Block | KnownBlock)[] | undefined;
    if (agentLabel) {
      const footerBlocks = buildFooterBlocks(`Sent via ${agentLabel}`);
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
        body.channel,
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
