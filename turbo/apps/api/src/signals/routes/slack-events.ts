import { slackEventsContract } from "@okouai/api-contracts/contracts/slack-events";

import type { RouteEntry } from "../route-entry";
import { handleSlackEvents$ } from "../services/slack-webhooks.service";

export const slackEventsRoutes: readonly RouteEntry[] = [
  {
    route: slackEventsContract.post,
    handler: handleSlackEvents$,
  },
];
