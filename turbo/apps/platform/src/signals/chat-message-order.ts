import type { PagedChatMessage } from "@vm0/api-contracts/contracts/chat-threads";

const TERMINAL_MESSAGE_ORDER_SEQUENCE = 2_147_483_647;

export function chatMessageOrderSequence(message: PagedChatMessage): number {
  if (message.role === "assistant" && message.runLifecycleEvent !== undefined) {
    return TERMINAL_MESSAGE_ORDER_SEQUENCE;
  }
  return message.sequenceNumber ?? -1;
}
