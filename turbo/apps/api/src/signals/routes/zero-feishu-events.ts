import { zeroFeishuEventsContract } from "@okouai/api-contracts/contracts/zero-feishu-events";

import type { RouteEntry } from "../route-entry";
import { handleZeroFeishuEvents$ } from "../services/zero-feishu-webhooks.service";

export const zeroFeishuEventsRoutes: readonly RouteEntry[] = [
  {
    route: zeroFeishuEventsContract.post,
    handler: handleZeroFeishuEvents$,
  },
];
