import { zeroSlackCommandsContract } from "@vm0/api-contracts/contracts/zero-slack-commands";

import type { RouteEntry } from "../route";
import { handleZeroSlackCommands$ } from "../services/zero-slack-webhooks.service";

export const zeroSlackCommandsRoutes: readonly RouteEntry[] = [
  {
    route: zeroSlackCommandsContract.post,
    handler: handleZeroSlackCommands$,
  },
];
