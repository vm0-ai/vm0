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

export function resetMockMemory(): void {
  mockMemory = { ...EMPTY_MEMORY };
}

export const apiMemoryHandlers = [
  mockApi(zeroMemoryContract.get, ({ respond }) => {
    return respond(200, mockMemory);
  }),
  mockApi(zeroMemoryContract.recall, ({ query, respond }) => {
    return respond(200, { query: query.q, memories: [] });
  }),
  mockApi(zeroMemoryContract.search, ({ query, respond }) => {
    return respond(200, {
      query: query.q,
      mode: query.mode ?? "hybrid",
      results: [],
    });
  }),
  mockApi(zeroMemoryContract.memories, ({ respond }) => {
    return respond(200, {
      memories: [],
      pagination: {
        page: 1,
        pageSize: 50,
        total: 0,
        totalPages: 1,
        hasMore: false,
      },
    });
  }),
  mockApi(zeroMemoryContract.createMemory, ({ respond }) => {
    return respond(200, {
      memory: {
        id: "00000000-0000-4000-8000-000000000901",
        kind: "key_fact",
        status: "active",
        text: "Mock memory",
        confidence: 90,
        sourceCount: 0,
        lastSeenAt: "2026-07-02T12:00:00.000Z",
        createdAt: "2026-07-02T12:00:00.000Z",
        updatedAt: "2026-07-02T12:00:00.000Z",
        contextSpace: null,
        entity: {
          id: "00000000-0000-4000-8000-000000000902",
          type: "organization",
          displayName: "Direct memories",
        },
      },
    });
  }),
  mockApi(zeroMemoryContract.updateMemory, ({ respond }) => {
    return respond(200, {
      memory: {
        id: "00000000-0000-4000-8000-000000000901",
        kind: "key_fact",
        status: "active",
        text: "Mock memory",
        confidence: 90,
        sourceCount: 0,
        lastSeenAt: "2026-07-02T12:00:00.000Z",
        createdAt: "2026-07-02T12:00:00.000Z",
        updatedAt: "2026-07-02T12:00:00.000Z",
        contextSpace: null,
        entity: {
          id: "00000000-0000-4000-8000-000000000902",
          type: "organization",
          displayName: "Direct memories",
        },
      },
    });
  }),
  mockApi(zeroMemoryContract.forgetMemory, ({ respond }) => {
    return respond(200, { forgotten: [] });
  }),
  mockApi(zeroMemoryContract.forgetPrompt, ({ respond }) => {
    return respond(200, { forgotten: [] });
  }),
  mockApi(zeroMemoryContract.documents, ({ respond }) => {
    return respond(200, {
      documents: [],
      pagination: {
        page: 1,
        pageSize: 50,
        total: 0,
        totalPages: 1,
        hasMore: false,
      },
    });
  }),
  mockApi(zeroMemoryContract.forgetDocument, ({ respond }) => {
    return respond(200, { forgotten: [] });
  }),
  mockApi(zeroMemoryContract.history, ({ respond }) => {
    return respond(200, { history: [] });
  }),
  mockApi(zeroMemoryContract.forgotten, ({ respond }) => {
    return respond(200, { forgotten: [] });
  }),
  mockApi(zeroMemoryContract.profiles, ({ respond }) => {
    return respond(200, { profiles: [] });
  }),
  mockApi(zeroMemoryContract.context, ({ query, respond }) => {
    return respond(200, {
      query: query.q ?? null,
      context: "",
      memories: [],
    });
  }),
];
