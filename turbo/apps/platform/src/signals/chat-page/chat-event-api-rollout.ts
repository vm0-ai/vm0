import {
  canonicalChatEvent,
  canonicalChatEventFromCompatibilityResponse,
  chatEventsContract,
  chatMessagesContract,
  chatThreadEventsContract,
  legacyChatMessageSendBody,
  precedingChatThreadMessagesContract,
  type ChatEvent,
  type ChatEventSendBody,
} from "@vm0/api-contracts/contracts/chat-threads";
import { withPrecedingStructuredPrompt } from "@vm0/api-contracts/contracts/user-message-rollout";

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

/**
 * One-release rollout bridge for deployments where the App reaches production
 * before the API. Remove after an App version using `/events` can no longer
 * encounter the preceding API release.
 */
export async function sendChatEventWithCompatibility(
  createClient: ZeroClientFactory,
  body: ChatEventSendBody,
  signal: AbortSignal,
) {
  const eventResult = await accept(
    createClient(chatEventsContract).send({
      body: withPrecedingStructuredPrompt(body),
      fetchOptions: { signal },
    }),
    [201, 404],
    signal,
  );
  if (eventResult.status === 201) {
    return eventResult.body;
  }

  const messageResult = await accept(
    createClient(chatMessagesContract).send({
      body: legacyChatMessageSendBody(body),
      fetchOptions: { signal },
    }),
    [201],
    signal,
  );
  return messageResult.body;
}

/**
 * Read-side companion to sendChatEventWithCompatibility. Legacy message rows
 * are converted at this boundary and never enter application state directly.
 */
export async function listChatEventsWithCompatibility(
  createClient: ZeroClientFactory,
  threadId: string,
  query: ChatEventListQuery,
  signal: AbortSignal,
): Promise<ChatEventListResult> {
  const eventResult = await accept(
    createClient(chatThreadEventsContract).list({
      params: { threadId },
      query,
      fetchOptions: { signal },
    }),
    [200, 404],
    signal,
  );
  if (eventResult.status === 200) {
    return {
      events: eventResult.body.events.map(canonicalChatEvent),
      hasHistoryBefore: eventResult.body.hasHistoryBefore ?? false,
    };
  }

  const messageResult = await accept(
    createClient(precedingChatThreadMessagesContract).list({
      params: { threadId },
      query,
      fetchOptions: { signal },
    }),
    [200],
    signal,
  );
  return {
    events: messageResult.body.messages.map((message) => {
      return canonicalChatEventFromCompatibilityResponse(threadId, message);
    }),
    hasHistoryBefore: messageResult.body.hasHistoryBefore ?? false,
  };
}
