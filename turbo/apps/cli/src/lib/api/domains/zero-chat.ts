import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";
import {
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadRenameContract,
  chatSearchContract,
  type ChatThreadMetadata,
  type ChatSearchResponse,
} from "@vm0/api-contracts/contracts/chat-threads";
import { getClientConfig, handleError } from "../core/client-factory";

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
