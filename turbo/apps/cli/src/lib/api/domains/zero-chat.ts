import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  type ChatEvent,
  type ChatEventSendBody,
  chatEventsContract,
  chatThreadEventsContract,
  isCanonicalChatEventResponse,
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
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

export type ZeroChatThreadEvent = Omit<ChatThreadEvent, "seqId"> & {
  readonly seqId?: number;
};

interface ZeroChatThreadCreateResult {
  readonly threadId: string;
  readonly title: string | null;
  readonly selectedModel: string | null;
}

interface ZeroChatEventSendResult {
  readonly runId: string | null;
  readonly threadId: string;
  readonly status?: string;
  readonly createdAt?: string;
}

type ZeroChatThreadEventsResult =
  | {
      readonly kind: "page";
      readonly events: readonly ZeroChatThreadEvent[];
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
      latestEventId: result.body.latestEventId,
      // CLI releases can reach an API that has not promoted sequence cursors
      // yet, so preserve the UUID cursor until the new field is present.
      latestSeqId: result.body.latestSeqId ?? null,
    };
  }
  handleError(result, "Failed to get chat thread snapshot");
}

export async function listZeroChatThreadEvents(options: {
  sinceSeqId?: number;
  sinceEventId?: string;
}): Promise<ZeroChatThreadEventsResult> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.events({
    query: {
      ...(options.sinceSeqId ? { sinceSeqId: options.sinceSeqId } : {}),
      ...(options.sinceEventId ? { sinceEventId: options.sinceEventId } : {}),
    },
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

export async function createZeroChatThread(options: {
  agentId: string;
  title: string;
  model?: string;
}): Promise<ZeroChatThreadCreateResult> {
  const config = await getClientConfig();
  const client = initClient(chatThreadsContract, config);
  const result = await client.create({
    body: {
      agentId: options.agentId,
      title: options.title,
      ...(options.model === undefined ? {} : { model: options.model }),
    },
  });
  if (result.status === 201) {
    return {
      threadId: result.body.id,
      title: result.body.title,
      // An API that predates the echoed pin leaves the CLI with only the
      // model the caller asked for.
      selectedModel: result.body.selectedModel ?? options.model ?? null,
    };
  }
  handleError(result, "Failed to create chat thread");
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

export async function getZeroChatThreadAgentId(options: {
  threadId: string;
}): Promise<string> {
  const thread = await getZeroChatThread(options);
  if (thread.agentId) {
    return thread.agentId;
  }

  // Compatibility fallback for an API version that predates agentId on the
  // narrow metadata response.
  const snapshot = await getZeroChatThreadSnapshot();
  const projection = snapshot.chatThreads.find((candidate) => {
    return candidate.id === options.threadId;
  });
  if (!projection) {
    throw new Error(
      `Chat thread "${options.threadId}" was not found in the thread snapshot`,
    );
  }
  return projection.agentId;
}

export async function sendZeroChatEvent(
  body: ChatEventSendBody,
): Promise<ZeroChatEventSendResult> {
  const config = await getClientConfig();
  const client = initClient(chatEventsContract, config);
  const result = await client.send({ body });
  if (result.status === 201) {
    return result.body;
  }
  handleError(result, "Failed to send chat event");
}

export async function listZeroChatEvents(options: {
  threadId: string;
  beforeSeqId?: number;
  limit?: number;
}): Promise<readonly ChatEvent[]> {
  const config = await getClientConfig();
  const client = initClient(chatThreadEventsContract, config);
  const result = await client.list({
    params: { threadId: options.threadId },
    query: {
      beforeSeqId: options.beforeSeqId,
      limit: options.limit,
    },
  });
  if (result.status === 200) {
    return result.body.events.filter(isCanonicalChatEventResponse);
  }
  handleError(result, "Failed to list chat events");
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
