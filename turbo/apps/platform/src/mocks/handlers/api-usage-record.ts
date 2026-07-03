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
  period: {
    start: "2026-03-01T00:00:00.000Z",
    end: "2026-03-02T00:00:00.000Z",
  },
  rows: [],
  totalCredits: 0,
  pagination: { page: 1, pageSize: 20, total: 0 },
};

let mockUsageRecordResponse: UsageRecordResponse = { ...defaultResponse };

export function resetMockUsageRecord(): void {
  mockUsageRecordResponse = {
    period: defaultResponse.period,
    rows: [],
    totalCredits: 0,
    pagination: { ...defaultResponse.pagination },
  };
}

export const apiUsageRecordHandlers = [
  mockApi(zeroUsageRecordContract.get, ({ query, respond }) => {
    const page = query.page;
    const pageSize = query.pageSize;
    const source = query.source;
    const rows = source
      ? mockUsageRecordResponse.rows.filter((row) => {
          return row.source === source;
        })
      : mockUsageRecordResponse.rows;
    const offset = (page - 1) * pageSize;

    return respond(200, {
      period: mockUsageRecordResponse.period,
      rows: rows.slice(offset, offset + pageSize),
      totalCredits: rows.reduce((sum, row) => {
        return sum + row.credits;
      }, 0),
      pagination: { page, pageSize, total: rows.length },
    });
  }),
];
