import { slackInteractiveContract } from "@okouai/api-contracts/contracts/slack-interactive";

import type { RouteEntry } from "../route-entry";
import { handleSlackInteractive$ } from "../services/slack-webhooks.service";

export const slackInteractiveRoutes: readonly RouteEntry[] = [
  {
    route: slackInteractiveContract.post,
    handler: handleSlackInteractive$,
  },
];
