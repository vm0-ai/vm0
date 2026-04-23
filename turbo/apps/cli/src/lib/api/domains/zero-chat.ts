import { initClient } from "@ts-rest/core";
import {
  chatSearchContract,
  type ChatSearchResponse,
} from "@vm0/core/contracts/chat-threads";
import { getClientConfig, handleError } from "../core/client-factory";

export async function searchZeroChat(options: {
  keyword: string;
  agent?: string;
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
      agent: options.agent,
      since: options.since,
      limit: options.limit,
      before: options.before,
      after: options.after,
    },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to search chat messages");
}
