/**
 * Usage Insight API Handlers
 *
 * Mock handler for /api/zero/usage/insight endpoint.
 */

import {
  zeroUsageInsightContract,
  type UsageInsightResponse,
} from "@vm0/api-contracts/contracts/zero-usage-insight";
import { mockApi } from "../msw-contract.ts";

const defaultResponse: UsageInsightResponse = {
  buckets: [],
  schedules: [],
  scheduleOtherCount: 0,
  scheduleOtherCredits: 0,
  chats: [],
  chatOtherCount: 0,
  chatOtherCredits: 0,
  emailCredits: 0,
  emailTokens: 0,
  slackCredits: 0,
  slackTokens: 0,
  grandTotalCredits: 0,
  grandTotalTokens: 0,
};

let mockUsageInsightResponse: UsageInsightResponse = { ...defaultResponse };

export function resetMockUsageInsight(): void {
  mockUsageInsightResponse = { ...defaultResponse };
}

export const apiUsageInsightHandlers = [
  mockApi(zeroUsageInsightContract.get, ({ respond }) => {
    return respond(200, mockUsageInsightResponse);
  }),
];
