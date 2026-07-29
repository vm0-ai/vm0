import type { ChatMessage } from "./chat-message-types.ts";

export function isCancelledRunEvent(
  event: ChatMessage,
): event is Extract<ChatMessage, { eventType: "run.cancelled" }> {
  return event.eventType === "run.cancelled";
}
