import {
  zeroMemoryContract,
  type MemoryDetailResponse,
} from "@vm0/api-contracts/contracts/zero-memory";

import { mockApi } from "../msw-contract.ts";

const EMPTY_MEMORY: MemoryDetailResponse = {
  exists: false,
  name: "memory",
  size: 0,
  fileCount: 0,
  updatedAt: null,
  files: [],
  fileContents: [],
};

let mockMemory: MemoryDetailResponse = { ...EMPTY_MEMORY };

export function setMockMemory(memory: MemoryDetailResponse): void {
  mockMemory = memory;
}

export function resetMockMemory(): void {
  mockMemory = { ...EMPTY_MEMORY };
}

export const apiMemoryHandlers = [
  mockApi(zeroMemoryContract.get, ({ respond }) => {
    return respond(200, mockMemory);
  }),
];
