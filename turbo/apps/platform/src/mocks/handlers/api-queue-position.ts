/**
 * Queue Position API Handlers
 *
 * Mock handlers for /api/queue-position endpoint.
 * Default behavior: position 0, total 0.
 */

import { queuePositionContract } from "@okouai/api-contracts/contracts/queue-position";
import { mockApi } from "../msw-contract.ts";

export const apiQueuePositionHandlers = [
  // GET /api/queue-position
  mockApi(queuePositionContract.getPosition, ({ respond }) =>
    respond(200, { position: 0, total: 0 }),
  ),
];
