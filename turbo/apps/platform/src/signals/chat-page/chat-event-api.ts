import {
  chatEventsContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import type { ZeroClientFactory } from "../api-client.ts";

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
