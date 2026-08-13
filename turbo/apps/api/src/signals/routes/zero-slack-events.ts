import { zeroSlackEventsContract } from "@okouai/api-contracts/contracts/zero-slack-events";

import type { RouteEntry } from "../route-entry";
import { handleZeroSlackEvents$ } from "../services/zero-slack-webhooks.service";

export const zeroSlackEventsRoutes: readonly RouteEntry[] = [
  {
    route: zeroSlackEventsContract.post,
    handler: handleZeroSlackEvents$,
  },
];
