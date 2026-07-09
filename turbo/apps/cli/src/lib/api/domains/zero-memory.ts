import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  zeroMemoryContract,
  type MemoryContextResponse,
  type MemoryRecallItemKind,
  type MemoryRecallResponse,
  type MemorySearchMode,
  type MemorySearchResponse,
  type MemorySourceProvider,
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
