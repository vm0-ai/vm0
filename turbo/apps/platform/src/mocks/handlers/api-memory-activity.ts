import {
  zeroMemoryActivityContract,
  type MemoryActivityResponse,
} from "@vm0/api-contracts/contracts/zero-memory-activity";

import { mockApi } from "../msw-contract.ts";

const EMPTY_ACTIVITY: MemoryActivityResponse = { entries: [] };

let mockMemoryActivity: MemoryActivityResponse = { ...EMPTY_ACTIVITY };

export function setMockMemoryActivity(activity: MemoryActivityResponse): void {
  mockMemoryActivity = activity;
}

export function resetMockMemoryActivity(): void {
  mockMemoryActivity = { ...EMPTY_ACTIVITY };
}

export const apiMemoryActivityHandlers = [
  mockApi(zeroMemoryActivityContract.get, ({ respond }) => {
    return respond(200, mockMemoryActivity);
  }),
];
