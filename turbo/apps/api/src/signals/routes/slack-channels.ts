import { computed } from "ccstate";
import { slackChannelsContract } from "@okouai/api-contracts/contracts/slack-channels";

import { listSharedSlackChannels } from "../../lib/slack-client";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { slackUserInstallation } from "../services/slack-data.service";
import type { RouteEntry } from "../route-entry";

const slackInstallationNotFound = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No Slack installation found for this org",
      code: "NOT_FOUND",
    }),
  }),
});

const slackConnectionNotFound = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No Slack account connected for this user",
      code: "NOT_FOUND",
    }),
  }),
});

const getSlackChannelsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const installation = await get(
    slackUserInstallation({ orgId: auth.orgId, userId: auth.userId }),
  );
  if (installation.kind === "not-installed") {
    return slackInstallationNotFound;
  }
  if (installation.kind === "not-connected") {
    return slackConnectionNotFound;
  }
  const channels = await listSharedSlackChannels(
    installation.botToken,
    installation.slackUserId,
  );
  return {
    status: 200 as const,
    body: { channels },
  };
});

export const slackChannelsRoutes: readonly RouteEntry[] = [
  {
    route: slackChannelsContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getSlackChannelsInner$,
    ),
  },
];
