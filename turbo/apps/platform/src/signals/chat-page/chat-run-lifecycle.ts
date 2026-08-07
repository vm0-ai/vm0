import type { ChatEvent } from "./chat-event-types.ts";

export function isCancelledRunEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "run.cancelled" }> {
  return event.eventType === "run.cancelled";
}
