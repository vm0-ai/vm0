import type { ChatEventType } from "@vm0/api-contracts/contracts/chat-events";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { inArray, type SQL } from "drizzle-orm";

export function chatEventTypeIn(eventTypes: readonly ChatEventType[]): SQL {
  return inArray(chatEvents.eventType, [...eventTypes]);
}
