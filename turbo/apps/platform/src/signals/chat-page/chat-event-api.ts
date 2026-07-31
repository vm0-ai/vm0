import {
  chatEventsContract,
  chatThreadEventsContract,
  type ChatEvent,
  type ChatEventSendBody,
} from "@vm0/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import type { ZeroClientFactory } from "../api-client.ts";

interface ChatEventListQuery {
  readonly sinceSeqId?: number;
  readonly beforeSeqId?: number;
  readonly sinceId?: string;
  readonly beforeId?: string;
  readonly limit?: number;
}

export async function sendChatEvent(
  createClient: ZeroClientFactory,
  body: ChatEventSendBody,
  signal: AbortSignal,
) {
  const result = await accept(
    createClient(chatEventsContract).send({
      body,
      fetchOptions: { signal },
    }),
    [201],
    signal,
  );
  return result.body;
}

export async function listChatEvents(
  createClient: ZeroClientFactory,
  threadId: string,
  query: ChatEventListQuery,
  signal: AbortSignal,
): Promise<ChatEvent[]> {
  const result = await accept(
    createClient(chatThreadEventsContract).list({
      params: { threadId },
      query,
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  return result.body.events;
}
