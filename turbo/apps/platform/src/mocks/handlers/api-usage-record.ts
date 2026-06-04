/**
 * Usage Record API Handlers
 *
 * Mock handler for /api/zero/usage/record endpoint.
 */

import {
  zeroUsageRecordContract,
  type UsageRecordResponse,
} from "@vm0/api-contracts/contracts/zero-usage-record";
import { mockApi } from "../msw-contract.ts";

const defaultResponse: UsageRecordResponse = {
  chats: [],
  pagination: { page: 1, pageSize: 20, total: 0 },
};

let mockUsageRecordResponse: UsageRecordResponse = { ...defaultResponse };

export function resetMockUsageRecord(): void {
  mockUsageRecordResponse = { ...defaultResponse };
}

export const apiUsageRecordHandlers = [
  mockApi(zeroUsageRecordContract.get, ({ respond }) => {
    return respond(200, mockUsageRecordResponse);
  }),
];
