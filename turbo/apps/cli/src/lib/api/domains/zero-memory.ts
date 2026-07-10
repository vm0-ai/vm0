import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  zeroMemoryContract,
  type MemoryContextResponse,
  type MemoryCreateRequest,
  type MemoryDocumentListResponse,
  type MemoryForgetByPromptRequest,
  type MemoryForgetRequest,
  type MemoryForgetResponse,
  type MemoryHistoryResponse,
  type MemoryKind,
  type MemoryLifecycleMemory,
  type MemoryListResponse,
  type MemoryRecallItemKind,
  type MemoryRecallResponse,
  type MemorySearchMode,
  type MemorySearchResponse,
  type MemorySourceProvider,
  type MemoryTombstoneListResponse,
  type MemoryUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-memory";

import { getClientConfig, handleError } from "../core/client-factory";

export async function recallZeroMemory(options: {
  readonly q: string;
  readonly kind?: MemoryRecallItemKind;
  readonly limit?: number;
}): Promise<MemoryRecallResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.recall({
    query: {
      q: options.q,
      kind: options.kind,
      limit: options.limit,
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to recall memory");
}

export async function getZeroMemoryContext(options: {
  readonly q?: string;
  readonly limit?: number;
}): Promise<MemoryContextResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.context({
    query: {
      q: options.q,
      limit: options.limit,
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to load memory context");
}

export async function searchZeroMemory(options: {
  readonly q: string;
  readonly mode?: MemorySearchMode;
  readonly provider?: MemorySourceProvider;
  readonly limit?: number;
}): Promise<MemorySearchResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.search({
    query: {
      q: options.q,
      mode: options.mode,
      provider: options.provider,
      limit: options.limit,
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to search memory");
}

export async function listZeroMemory(options: {
  readonly status?: "active" | "archived";
  readonly kind?: MemoryKind;
  readonly limit?: number;
}): Promise<MemoryListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.memories({
    query: {
      status: options.status,
      kind: options.kind,
      limit: options.limit,
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to list memory");
}

export async function createZeroMemory(
  request: MemoryCreateRequest,
): Promise<MemoryLifecycleMemory> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.createMemory({ body: request });
  if (result.status === 200) {
    return result.body.memory;
  }
  handleError(result, "Failed to create memory");
}

export async function updateZeroMemory(
  memoryId: string,
  request: MemoryUpdateRequest,
): Promise<MemoryLifecycleMemory> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.updateMemory({
    params: { memoryId },
    body: request,
  });
  if (result.status === 200) {
    return result.body.memory;
  }
  handleError(result, "Failed to update memory");
}

export async function forgetZeroMemory(
  memoryId: string,
  request: MemoryForgetRequest,
): Promise<MemoryForgetResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.forgetMemory({
    params: { memoryId },
    body: request,
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to forget memory");
}

export async function forgetZeroMemoryByPrompt(
  request: MemoryForgetByPromptRequest,
): Promise<MemoryForgetResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.forgetPrompt({ body: request });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to forget memory by prompt");
}

export async function listZeroMemoryHistory(options: {
  readonly targetKind: "memory" | "document" | "profile";
  readonly targetId: string;
  readonly limit?: number;
}): Promise<MemoryHistoryResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.history({
    query: {
      targetKind: options.targetKind,
      targetId: options.targetId,
      limit: options.limit,
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to list memory history");
}

export async function listZeroMemoryDocuments(options: {
  readonly status?: "active" | "archived" | "deleted";
  readonly provider?: MemorySourceProvider;
  readonly limit?: number;
}): Promise<MemoryDocumentListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.documents({
    query: {
      status: options.status,
      provider: options.provider,
      limit: options.limit,
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to list memory documents");
}

export async function listZeroMemoryForgotten(options: {
  readonly limit?: number;
}): Promise<MemoryTombstoneListResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroMemoryContract, config);
  const result = await client.forgotten({
    query: {
      limit: options.limit,
    },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to list forgotten memory");
}
