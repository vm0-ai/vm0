/**
 * Queue Position API Handlers
 *
 * Mock handlers for /api/okou/queue-position endpoint.
 * Default behavior: position 0, total 0.
 */

import { queuePositionContract } from "@okouai/api-contracts/contracts/queue-position";
import { mockApi } from "../msw-contract.ts";

export const apiQueuePositionHandlers = [
  // GET /api/okou/queue-position
  mockApi(queuePositionContract.getPosition, ({ respond }) =>
    respond(200, { position: 0, total: 0 }),
  ),
];
