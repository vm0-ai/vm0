import { command } from "ccstate";
import type { Block, KnownBlock } from "@slack/web-api";
import { integrationsSlackMessageContract } from "@vm0/api-contracts/contracts/integrations";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  createSlackClient,
  openDMChannel,
  postMessage,
} from "../external/slack-message-client";
import { zeroSlackOrgInstallation } from "../services/zero-slack-data.service";
import {
  resolveCurrentUserSlackId,
  slackMessageSendFooterText,
} from "../services/zero-integrations-slack-message.service";
import { buildFooterBlocks } from "../../lib/slack-blocks";
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

const noUserConnection = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message:
        "No Slack connection found for current user. Connect your Slack account first.",
      code: "NOT_FOUND",
    }),
  }),
});

const sendMessageInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const authRunId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;

  const bodyResult = await get(
    bodyResultOf(integrationsSlackMessageContract.sendMessage),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const installation = await get(
    zeroSlackOrgInstallation({ orgId: auth.orgId, userId: auth.userId }),
  );
  signal.throwIfAborted();
  if (!installation) {
    return noInstallation;
  }

  const client = createSlackClient(installation.botToken);

  const footerText = await get(slackMessageSendFooterText({ authRunId }));
  signal.throwIfAborted();

  let targetChannel: string;
  if (body.user) {
    let slackUserId = body.user;
    if (slackUserId === "me") {
      const resolved = await get(
        resolveCurrentUserSlackId({
          userId: auth.userId,
          orgId: auth.orgId,
        }),
      );
      signal.throwIfAborted();
      if (!resolved) {
        return noUserConnection;
      }
      slackUserId = resolved;
    }

    const dm = await openDMChannel(client, slackUserId);
    signal.throwIfAborted();
    if (dm.kind === "slack_error") {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Cannot open DM: ${dm.error}`,
            code: "NOT_FOUND",
          },
        },
      };
    }
    targetChannel = dm.channelId;
  } else {
    targetChannel = body.channel!;
  }

  let finalBlocks = body.blocks as (Block | KnownBlock)[] | undefined;
  if (footerText) {
    const footerBlocks = buildFooterBlocks(footerText);
    if (finalBlocks && finalBlocks.length > 0) {
      finalBlocks = [...finalBlocks, ...footerBlocks];
    } else if (body.text) {
      finalBlocks = [
        { type: "section", text: { type: "mrkdwn", text: body.text } },
        ...footerBlocks,
      ];
    } else {
      finalBlocks = footerBlocks;
    }
  }

  const result = await postMessage(client, targetChannel, body.text ?? "", {
    threadTs: body.threadTs,
    blocks: finalBlocks,
  });
  signal.throwIfAborted();
  if (result.kind === "slack_error") {
    return {
      status: 400 as const,
      body: {
        error: {
          message: `Slack API error: ${result.error}`,
          code: "SLACK_ERROR",
        },
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      ts: result.ts,
      channel: result.channel,
    },
  };
});

const slackWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "slack:write",
} as const;

export const zeroIntegrationsSlackMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsSlackMessageContract.sendMessage,
    handler: authRoute(slackWriteAuth, sendMessageInner$),
  },
];
