/**
 * Queue Position API Handlers
 *
 * Mock handlers for /api/zero/queue-position endpoint.
 * Default behavior: position 0, total 0.
 */

import { zeroQueuePositionContract } from "@vm0/core/contracts/zero-queue-position";
import { mockApi } from "../msw-contract.ts";

export const apiQueuePositionHandlers = [
  // GET /api/zero/queue-position
  mockApi(zeroQueuePositionContract.getPosition, ({ respond }) =>
    respond(200, { position: 0, total: 0 }),
  ),
];
