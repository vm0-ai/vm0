import {
  chatEventResponseSchema,
  chatEventSchema,
  chatEventsContract,
  chatThreadEventsContract,
  type ChatEvent,
  type ChatEventResponse,
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

interface ChatEventListResult {
  readonly events: ChatEvent[];
  readonly hasHistoryBefore: boolean;
}

function canonicalChatEventFromResponse(
  response: ChatEventResponse,
): ChatEvent {
  const parsed = chatEventResponseSchema.parse(response);
  if (!("role" in parsed)) {
    return parsed;
  }
  if (
    parsed.revokesMessageId !== undefined &&
    parsed.revokesMessageId !== parsed.revokesEventId
  ) {
    throw new Error("Chat event revoke compatibility fields disagree");
  }
  const { role, revokesMessageId, ...event } = parsed;
  void role;
  void revokesMessageId;
  return chatEventSchema.parse(event);
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
): Promise<ChatEventListResult> {
  const result = await accept(
    createClient(chatThreadEventsContract).list({
      params: { threadId },
      query,
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  return {
    events: result.body.events.map(canonicalChatEventFromResponse),
    hasHistoryBefore: result.body.hasHistoryBefore ?? false,
  };
}
