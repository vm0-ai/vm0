/**
 * Usage API Handlers
 *
 * Mock handlers for /api/zero/usage/members and
 * /api/zero/org/members/credit-cap endpoints.
 */

import {
  zeroUsageMembersContract,
  zeroMemberCreditCapContract,
  type UsageMembersResponse,
} from "@vm0/core";
import { mockApi } from "../msw-contract.ts";

let mockUsageMembersResponse: UsageMembersResponse = {
  period: null,
  members: [],
};

const mockCreditCaps = new Map<
  string,
  { creditCap: number | null; creditEnabled: boolean }
>();

export function setMockUsageMembers(
  overrides: Partial<UsageMembersResponse>,
): void {
  mockUsageMembersResponse = { ...mockUsageMembersResponse, ...overrides };
}

export function resetMockUsageMembers(): void {
  mockUsageMembersResponse = { period: null, members: [] };
}

export function setMockMemberCreditCap(
  userId: string,
  creditCap: number | null,
  creditEnabled: boolean,
): void {
  mockCreditCaps.set(userId, { creditCap, creditEnabled });
}

export function resetMockMemberCreditCaps(): void {
  mockCreditCaps.clear();
}

export const apiUsageHandlers = [
  mockApi(zeroUsageMembersContract.get, ({ respond }) => {
    return respond(200, mockUsageMembersResponse);
  }),

  mockApi(zeroMemberCreditCapContract.get, ({ query, respond }) => {
    const entry = mockCreditCaps.get(query.userId);
    if (!entry) {
      return respond(200, {
        userId: query.userId,
        creditCap: null,
        creditEnabled: true,
      });
    }
    return respond(200, {
      userId: query.userId,
      creditCap: entry.creditCap,
      creditEnabled: entry.creditEnabled,
    });
  }),

  mockApi(zeroMemberCreditCapContract.set, ({ body, respond }) => {
    const existing = mockCreditCaps.get(body.userId);
    mockCreditCaps.set(body.userId, {
      creditCap: body.creditCap,
      creditEnabled: existing?.creditEnabled ?? true,
    });
    return respond(200, {
      userId: body.userId,
      creditCap: body.creditCap,
      creditEnabled: existing?.creditEnabled ?? true,
    });
  }),
];
