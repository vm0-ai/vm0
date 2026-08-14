import { feishuEventsContract } from "@okouai/api-contracts/contracts/feishu-events";

import type { RouteEntry } from "../route-entry";
import { handleFeishuEvents$ } from "../services/feishu-webhooks.service";

export const feishuEventsRoutes: readonly RouteEntry[] = [
  {
    route: feishuEventsContract.post,
    handler: handleFeishuEvents$,
  },
];
