/**
 * Insights API Handlers
 *
 * Mock handlers for /api/zero/insights endpoint.
 * Default behavior: empty insights.
 */

import { zeroInsightsContract } from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

export const apiInsightsHandlers = [
  // GET /api/zero/insights
  mockApi(zeroInsightsContract.get, ({ respond }) =>
    respond(200, {
      days: [],
      totalCredits: 0,
      totalRuns: 0,
      lastUpdated: null,
    }),
  ),
];
