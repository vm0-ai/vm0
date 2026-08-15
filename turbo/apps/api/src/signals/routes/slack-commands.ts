import { slackCommandsContract } from "@okouai/api-contracts/contracts/slack-commands";

import type { RouteEntry } from "../route-entry";
import { handleSlackCommands$ } from "../services/slack-webhooks.service";

export const slackCommandsRoutes: readonly RouteEntry[] = [
  {
    route: slackCommandsContract.post,
    handler: handleSlackCommands$,
  },
];
