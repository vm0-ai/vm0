import { computed } from "ccstate";
import { zeroSlackChannelsContract } from "@vm0/api-contracts/contracts/zero-slack-channels";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroSlackChannels } from "../services/zero-slack-data.service";
import type { RouteEntry } from "../route";

const slackInstallationNotFound = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No Slack installation found for this org",
      code: "NOT_FOUND",
    }),
  }),
});

const getSlackChannelsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const channels = await get(
    zeroSlackChannels({ orgId: auth.orgId, userId: auth.userId }),
  );
  if (channels === null) {
    return slackInstallationNotFound;
  }
  return {
    status: 200 as const,
    body: { channels: [...channels] },
  };
});

export const zeroSlackChannelsRoutes: readonly RouteEntry[] = [
  {
    route: zeroSlackChannelsContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getSlackChannelsInner$,
    ),
  },
];
