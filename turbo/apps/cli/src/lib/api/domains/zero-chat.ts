import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  type ChatEvent,
  type ChatEventSendBody,
  chatEventsContract,
  chatThreadEventsContract,
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
import { isSupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import { getClientConfig, handleError } from "../core/client-factory";

export interface ZeroChatThreadSnapshot {
  readonly chatThreads: readonly ChatThreadSnapshotProjection[];
  readonly latestEventId: string | null;
  readonly latestSeqId: number | null;
}

export type ZeroChatThreadEvent = ChatThreadEvent;

function requireSupportedModel(model: string) {
  if (!isSupportedRunModel(model)) {
    throw new Error(`Unsupported chat model: ${model}`);
  }
  return model;
}

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
    query:
      options.sinceSeqId === undefined
        ? {}
        : { sinceSeqId: options.sinceSeqId },
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
      ...(options.model === undefined
        ? {}
        : { model: requireSupportedModel(options.model) }),
    },
  });
  if (result.status === 201) {
    return {
      threadId: result.body.id,
      title: result.body.title,
      selectedModel: result.body.selectedModel,
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
  return thread.agentId;
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
    return result.body.events;
  }
  handleError(result, "Failed to list chat events");
}

export async function updateZeroChatThreadModelSelection(options: {
  threadId: string;
  model: string | null;
}): Promise<{ threadId: string; selectedModel: string | null }> {
  const config = await getClientConfig();
  const client = initClient(chatThreadModelSelectionContract, config);
  const model =
    options.model === null ? null : requireSupportedModel(options.model);
  const result = await client.update({
    params: { id: options.threadId },
    body: { model },
  });
  if (result.status === 204) {
    return {
      threadId: options.threadId,
      selectedModel: model,
    };
  }
  handleError(result, "Failed to update chat thread model");
}
