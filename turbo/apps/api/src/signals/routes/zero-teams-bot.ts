import { command } from "ccstate";
import { zeroTeamsBotContract } from "@vm0/api-contracts/contracts/zero-teams-bot";

import {
  normalizeTeamsActivity,
  readTeamsActivityChannelId,
  readTeamsActivityServiceUrl,
} from "../../lib/teams-bot-activity";
import { verifyTeamsBotAuthorization } from "../../lib/teams-bot-auth";
import { authorization$, request$ } from "../context/hono";
import { now } from "../external/time";
import type { RouteEntry } from "../route-entry";
import {
  buildTeamsConnectUrlForActivity,
  publishTeamsChanged$,
  recordTeamsInstallationActivity$,
} from "../services/zero-teams-connect.service";
import { dispatchTeamsMessageToAgent$ } from "../services/zero-teams-dispatch.service";
import { safeJsonParse } from "../utils";

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
