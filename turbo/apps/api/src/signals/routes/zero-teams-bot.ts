import { command } from "ccstate";
import { zeroTeamsBotContract } from "@vm0/api-contracts/contracts/zero-teams-bot";

import {
  normalizeTeamsActivity,
  readTeamsActivityChannelId,
  readTeamsActivityServiceUrl,
} from "../../lib/teams-bot-activity";
import { verifyTeamsBotAuthorization } from "../../lib/teams-bot-auth";
import { authorization$, request$ } from "../context/hono";
import { safeJsonParse } from "../utils";
import type { RouteEntry } from "../route-entry";

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

const handleZeroTeamsBot$ = command(async ({ get }, signal: AbortSignal) => {
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
    return errorResponse(auth.status, auth.message, authErrorCode(auth.status));
  }

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      activity: normalized.activity,
    },
  };
});

export const zeroTeamsBotRoutes: readonly RouteEntry[] = [
  {
    route: zeroTeamsBotContract.post,
    handler: handleZeroTeamsBot$,
  },
];
