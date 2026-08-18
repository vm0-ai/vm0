import {
  usageMembersContract,
  type UsageMembersResponse,
} from "@okouai/api-contracts/contracts/usage";
import { mockApi } from "../msw-contract.ts";

let mockUsageMembersResponse: UsageMembersResponse = {
  period: null,
  members: [],
};

export function resetMockUsageMembers(): void {
  mockUsageMembersResponse = { period: null, members: [] };
}

export const apiUsageHandlers = [
  mockApi(usageMembersContract.get, ({ respond }) => {
    return respond(200, mockUsageMembersResponse);
  }),
];
