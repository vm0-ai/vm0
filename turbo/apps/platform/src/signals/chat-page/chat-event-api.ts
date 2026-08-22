import {
  chatEventsContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import type { ApiClientFactory } from "../api-client.ts";

export async function sendChatEvent(
  createClient: ApiClientFactory,
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
