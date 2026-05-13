import { zeroSlackEventsContract } from "@vm0/api-contracts/contracts/zero-slack-events";

import type { RouteEntry } from "../route";
import { handleZeroSlackEvents$ } from "../services/zero-slack-webhooks.service";

export const zeroSlackEventsRoutes: readonly RouteEntry[] = [
  {
    route: zeroSlackEventsContract.post,
    handler: handleZeroSlackEvents$,
  },
];
