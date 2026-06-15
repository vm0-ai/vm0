import { zeroSlackInteractiveContract } from "@vm0/api-contracts/contracts/zero-slack-interactive";

import type { RouteEntry } from "../route";
import { handleZeroSlackInteractive$ } from "../services/zero-slack-webhooks.service";

export const zeroSlackInteractiveRoutes: readonly RouteEntry[] = [
  {
    route: zeroSlackInteractiveContract.post,
    handler: handleZeroSlackInteractive$,
  },
];
