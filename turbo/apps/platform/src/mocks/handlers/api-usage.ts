import {
  zeroUsageMembersContract,
  type UsageMembersResponse,
} from "@vm0/api-contracts/contracts/zero-usage";
import { mockApi } from "../msw-contract.ts";

let mockUsageMembersResponse: UsageMembersResponse = {
  period: null,
  members: [],
};

export function setMockUsageMembers(
  overrides: Partial<UsageMembersResponse>,
): void {
  mockUsageMembersResponse = { ...mockUsageMembersResponse, ...overrides };
}

export function resetMockUsageMembers(): void {
  mockUsageMembersResponse = { period: null, members: [] };
}

export const apiUsageHandlers = [
  mockApi(zeroUsageMembersContract.get, ({ respond }) => {
    return respond(200, mockUsageMembersResponse);
  }),
];
