import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  chatThreadsContract,
  type ChatThreadEvent,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadRenameContract,
  chatSearchContract,
  type ChatThreadMetadata,
  type ChatThreadSnapshotProjection,
  type ChatSearchResponse,
} from "@vm0/api-contracts/contracts/chat-threads";
import { getClientConfig, handleError } from "../core/client-factory";

export interface ZeroChatThreadSnapshot {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestSeqId: number | null;
}

type ZeroChatThreadEventsResult =
  | {
      readonly kind: "page";
      readonly events: readonly ChatThreadEvent[];
      readonly hasMore: boolean;
    }
  | { readonly kind: "expired" };

export async function searchZeroChat(options: {
  keyword: string;
  agentId?: string;
  since?: number;
  limit?: number;
  before?: number;
  after?: number;
}): Promise<ChatSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(chatSearchContract, config);
  const result = await client.search({
    query: {
      keyword: options.keyword,
      agentId: options.agentId,
      since: options.since,
      limit: options.limit,
      before: options.before,
      after: options.after,
    },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to search chat messages");
}

export async function getZeroChatThreadSnapshot(): Promise<ZeroChatThreadSnapshot> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.snapshot();
  if (result.status === 200) {
    return {
      chatThreads: result.body.chatThreads,
      latestSeqId: result.body.latestSeqId,
    };
  }
  handleError(result, "Failed to get chat thread snapshot");
}

export async function listZeroChatThreadEvents(options: {
  sinceSeqId?: number;
}): Promise<ZeroChatThreadEventsResult> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.events({
    query: options.sinceSeqId ? { sinceSeqId: options.sinceSeqId } : {},
  });
  if (result.status === 200) {
    return {
      kind: "page",
      events: result.body.events,
      hasMore: result.body.hasMore,
    };
  }
  if (result.status === 410) {
    return { kind: "expired" };
  }
  handleError(result, "Failed to list chat thread events");
}

export async function renameZeroChatThread(options: {
  threadId: string;
  title: string;
}): Promise<{ threadId: string; title: string }> {
  const config = await getClientConfig();
  const client = initClient(chatThreadRenameContract, config);
  const result = await client.rename({
    params: { id: options.threadId },
    body: { title: options.title },
  });
  if (result.status === 204) {
    return { threadId: options.threadId, title: options.title };
  }
  handleError(result, "Failed to rename chat thread");
}

export async function getZeroChatThread(options: {
  threadId: string;
}): Promise<ChatThreadMetadata> {
  const config = await getClientConfig();
  const client = initClient(chatThreadMetadataContract, config);
  const result = await client.get({
    params: { id: options.threadId },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to get chat thread");
}

export async function updateZeroChatThreadModelSelection(options: {
  threadId: string;
  model: string | null;
}): Promise<{ threadId: string; selectedModel: string | null }> {
  const config = await getClientConfig();
  const client = initClient(chatThreadModelSelectionContract, config);
  const result = await client.update({
    params: { id: options.threadId },
    body: { model: options.model },
  });
  if (result.status === 204) {
    return {
      threadId: options.threadId,
      selectedModel: options.model,
    };
  }
  handleError(result, "Failed to update chat thread model");
}
