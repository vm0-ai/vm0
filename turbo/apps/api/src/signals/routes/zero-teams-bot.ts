import { command } from "ccstate";
import {
  zeroTeamsBotContract,
  type TeamsInboundActivity,
} from "@vm0/api-contracts/contracts/zero-teams-bot";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";

import {
  normalizeTeamsActivity,
  readTeamsActivityChannelId,
  readTeamsActivityServiceUrl,
} from "../../lib/teams-bot-activity";
import { env } from "../../lib/env";
import { verifyTeamsBotAuthorization } from "../../lib/teams-bot-auth";
import { logger } from "../../lib/log";
import { authorization$, request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import {
  deleteTeamsReaction,
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
import { ApiDispatchTimingCollector } from "../services/api-dispatch-timing.service";
import { bestEffort, safeJsonParse, tapError } from "../utils";

const L = logger("TeamsBot");
const TEAMS_LOGIN_PROMPT_CARD_TEXT =
  "Please connect your account to use Zero in this Teams workspace.";
const TEAMS_THINKING_REACTION_TYPE = "1f4ad_thoughtballoon";

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

type TeamsDispatchReplySource =
  | {
      readonly kind: "notice";
      readonly replyText: string;
      readonly connectUrl?: string;
      readonly card?: TeamsAdaptiveCard;
    }
  | { readonly kind: "failed"; readonly replyText: string }
  | { readonly kind: "queued" }
  | { readonly kind: "ignored" | "accepted" };

type TeamsMessageActivity = Extract<TeamsInboundActivity, { kind: "message" }>;
type TeamsInstallation = typeof teamsOrgInstallations.$inferSelect;

function dispatchReplyContent(dispatch: TeamsDispatchReplySource): {
  readonly replyText: string | null;
  readonly card?: TeamsAdaptiveCard;
} {
  if (dispatch.kind === "notice") {
    return {
      replyText: dispatch.replyText,
      ...(dispatch.card
        ? { card: dispatch.card }
        : dispatch.connectUrl
          ? {
              card: buildTeamsLoginPromptCard({
                connectUrl: dispatch.connectUrl,
              }),
            }
          : {}),
    };
  }
  if (dispatch.kind === "failed") {
    return { replyText: dispatch.replyText };
  }
  if (dispatch.kind === "queued") {
    const url = queueUrl();
    return {
      replyText: buildTeamsQueueText(url),
      card: buildTeamsQueueCard({ url }),
    };
  }
  return { replyText: null };
}

async function clearTeamsThinkingReactionForActivity(args: {
  readonly activity: TeamsMessageActivity;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (
    args.activity.conversationType === "personal" ||
    !args.activity.activityId
  ) {
    return;
  }

  await bestEffort(
    deleteTeamsReaction({
      serviceUrl: args.activity.serviceUrl,
      conversationId: args.activity.conversationId,
      activityId: args.activity.activityId,
      tenantId: args.activity.tenantId,
      reactionType: TEAMS_THINKING_REACTION_TYPE,
      signal: args.signal,
    }),
    args.signal,
  );
}

const dispatchTeamsMessageAndReply$ = command(
  async (
    { set },
    args: {
      readonly activity: TeamsMessageActivity;
      readonly installation: TeamsInstallation | null;
      readonly apiStartTime: number;
      readonly timing: ApiDispatchTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const dispatch = await set(
      dispatchTeamsMessageToAgent$,
      {
        activity: args.activity,
        installation: args.installation,
        apiStartTime: args.apiStartTime,
        timing: args.timing,
      },
      signal,
    );
    signal.throwIfAborted();

    if (dispatch.kind === "failed") {
      await clearTeamsThinkingReactionForActivity({
        activity: args.activity,
        signal,
      });
      signal.throwIfAborted();
    }

    const { replyText, card } = dispatchReplyContent(dispatch);
    if (!replyText) {
      return;
    }

    const reply = await sendTeamsMessageReply({
      serviceUrl: args.activity.serviceUrl,
      conversationId: args.activity.conversationId,
      activityId: args.activity.activityId ?? undefined,
      tenantId: args.activity.tenantId,
      text: replyText,
      ...(card ? { card } : {}),
      signal,
    });
    signal.throwIfAborted();

    if (reply.kind === "teams-error") {
      L.warn("Teams dispatch reply failed", {
        tenantId: args.activity.tenantId,
        conversationId: args.activity.conversationId,
        activityId: args.activity.activityId,
        status: reply.status,
        error: reply.error,
      });
    }
  },
);

const handleZeroTeamsBot$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    const apiStartTime = now();
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
    if (
      activityResult.kind === "upserted" &&
      activityResult.installation.orgId
    ) {
      await set(
        publishTeamsChanged$,
        { orgId: activityResult.installation.orgId },
        signal,
      );
      signal.throwIfAborted();
    }

    const installation =
      activityResult.kind === "upserted" ? activityResult.installation : null;
    const timing = new ApiDispatchTimingCollector();
    timing.recordElapsed(
      "api_dispatch_pre_create_zero_teams_entrypoint_gap",
      "nested",
      apiStartTime,
    );
    if (normalized.activity.kind === "message") {
      waitUntil(
        tapError(
          set(
            dispatchTeamsMessageAndReply$,
            {
              activity: normalized.activity,
              installation,
              apiStartTime,
              timing,
            },
            signal,
          ),
          (error) => {
            L.error("Error handling Teams message activity", { error });
          },
        ),
      );
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
