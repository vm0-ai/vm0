import type { ChatEventType } from "@vm0/api-contracts/contracts/chat-events";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { inArray, type SQL } from "drizzle-orm";

export function chatEventTypeIn(eventTypes: readonly ChatEventType[]): SQL {
  return inArray(chatMessages.eventType, [...eventTypes]);
}
