import { command } from "ccstate";
import { zeroTeamsBotContract } from "@vm0/api-contracts/contracts/zero-teams-bot";

import {
  normalizeTeamsActivity,
  readTeamsActivityChannelId,
  readTeamsActivityServiceUrl,
} from "../../lib/teams-bot-activity";
import { env } from "../../lib/env";
import { verifyTeamsBotAuthorization } from "../../lib/teams-bot-auth";
import { logger } from "../../lib/log";
import { authorization$, request$ } from "../context/hono";
import {
  sendTeamsMessageReply,
  type TeamsAdaptiveCard,
} from "../external/teams-bot-client";
import { now } from "../external/time";
import type { RouteEntry } from "../route-entry";
import {
  buildTeamsConnectUrlForActivity,
  publishTeamsChanged$,
  recordTeamsInstallationActivity$,
} from "../services/zero-teams-connect.service";
import { dispatchTeamsMessageToAgent$ } from "../services/zero-teams-dispatch.service";
import { safeJsonParse } from "../utils";

const L = logger("TeamsBot");
const TEAMS_LOGIN_PROMPT_CARD_TEXT =
  "Please connect your account to use Zero in this Teams workspace.";

function errorResponse(
  status: 400 | 401 | 403 | 503,
  message: string,
  code: string,
) {
  return {
    status,
    body: {
      error: { message, code },
    },
  };
}

function authErrorCode(status: 401 | 403 | 503): string {
  if (status === 403) {
    return "FORBIDDEN";
  }
  if (status === 503) {
    return "PROVIDER_UNAVAILABLE";
  }
  return "UNAUTHORIZED";
}

function buildTeamsLoginPromptCard(args: {
  readonly connectUrl: string;
}): TeamsAdaptiveCard {
  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: TEAMS_LOGIN_PROMPT_CARD_TEXT,
        wrap: true,
      },
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "Connect",
        url: args.connectUrl,
      },
    ],
  };
}

function queueUrl(): string {
  return `${env("APP_URL")}/?queue=1`;
}

function buildTeamsQueueText(url: string): string {
  return `\u26a0 Run queued -- concurrency limit reached. Will start automatically when a slot is available. [View queue](${url})`;
}

function buildTeamsQueueCard(args: {
  readonly url: string;
}): TeamsAdaptiveCard {
  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Run queued",
        wrap: true,
      },
      {
        type: "TextBlock",
        text: "Concurrency limit reached. Will start automatically when a slot is available.",
        wrap: true,
      },
    ],
    actions: [
      {
        type: "Action.OpenUrl",
        title: "View queue",
        url: args.url,
      },
    ],
  };
}

const handleZeroTeamsBot$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    const bodyText = await request.text();
    signal.throwIfAborted();

    const body = safeJsonParse(bodyText);
    const normalized = normalizeTeamsActivity(body);
    if (!normalized.ok) {
      return errorResponse(400, normalized.error, "BAD_REQUEST");
    }

    const serviceUrl =
      normalized.activity.kind === "unsupported"
        ? readTeamsActivityServiceUrl(body)
        : normalized.activity.serviceUrl;
    if (!serviceUrl) {
      return errorResponse(
        400,
        "Missing Teams activity serviceUrl",
        "BAD_REQUEST",
      );
    }

    const auth = await verifyTeamsBotAuthorization({
      authorization: get(authorization$),
      serviceUrl,
      channelId: readTeamsActivityChannelId(body),
    });
    signal.throwIfAborted();

    if (!auth.ok) {
      return errorResponse(
        auth.status,
        auth.message,
        authErrorCode(auth.status),
      );
    }

    const activityResult = await set(
      recordTeamsInstallationActivity$,
      normalized.activity,
      signal,
    );
    signal.throwIfAborted();

    if (activityResult.kind === "removed" && activityResult.orgId) {
      await set(
        publishTeamsChanged$,
        { orgId: activityResult.orgId, userIds: activityResult.userIds },
        signal,
      );
      signal.throwIfAborted();
    }

    const installation =
      activityResult.kind === "upserted" ? activityResult.installation : null;
    const dispatch = await set(
      dispatchTeamsMessageToAgent$,
      {
        activity: normalized.activity,
        installation,
        apiStartTime: now(),
      },
      signal,
    );
    signal.throwIfAborted();

    if (normalized.activity.kind === "message") {
      const queueNoticeUrl = dispatch.kind === "queued" ? queueUrl() : null;
      const replyText =
        dispatch.kind === "notice" || dispatch.kind === "failed"
          ? dispatch.replyText
          : queueNoticeUrl
            ? buildTeamsQueueText(queueNoticeUrl)
            : null;
      const card =
        dispatch.kind === "notice" && dispatch.connectUrl
          ? buildTeamsLoginPromptCard({
              connectUrl: dispatch.connectUrl,
            })
          : queueNoticeUrl
            ? buildTeamsQueueCard({ url: queueNoticeUrl })
            : undefined;
      if (!replyText) {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            activity: normalized.activity,
            connectUrl: buildTeamsConnectUrlForActivity({
              activity: normalized.activity,
              installation,
            }),
            dispatch,
          },
        };
      }

      const reply = await sendTeamsMessageReply({
        serviceUrl: normalized.activity.serviceUrl,
        conversationId: normalized.activity.conversationId,
        activityId: normalized.activity.activityId ?? undefined,
        tenantId: normalized.activity.tenantId,
        text: replyText,
        ...(card ? { card } : {}),
        signal,
      });
      signal.throwIfAborted();

      if (reply.kind === "teams-error") {
        L.warn("Teams dispatch reply failed", {
          tenantId: normalized.activity.tenantId,
          conversationId: normalized.activity.conversationId,
          activityId: normalized.activity.activityId,
          status: reply.status,
          error: reply.error,
        });
      }
    }

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        activity: normalized.activity,
        connectUrl: buildTeamsConnectUrlForActivity({
          activity: normalized.activity,
          installation,
        }),
        dispatch,
      },
    };
  },
);

export const zeroTeamsBotRoutes: readonly RouteEntry[] = [
  {
    route: zeroTeamsBotContract.post,
    handler: handleZeroTeamsBot$,
  },
];
