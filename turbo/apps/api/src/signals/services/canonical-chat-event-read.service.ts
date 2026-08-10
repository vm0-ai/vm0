import { chatEvents } from "@vm0/db/schema/chat-event";
import { sql, type SQLWrapper } from "drizzle-orm";

import { nullableDriverValueDecoder } from "../../lib/db-structured-result";

/** Canonical payload leaves projected from chat_events.payload. */
export function canonicalChatEventContent(
  payload: SQLWrapper = chatEvents.payload,
) {
  return sql`${payload}->>'content'`.mapWith(
    nullableDriverValueDecoder(chatEvents.content),
  );
}

export function canonicalChatEventUserMessage(
  payload: SQLWrapper = chatEvents.payload,
) {
  return sql`${payload}->'userMessage'`.mapWith(
    nullableDriverValueDecoder(chatEvents.userMessage),
  );
}

export function canonicalChatEventError(
  payload: SQLWrapper = chatEvents.payload,
) {
  return sql`${payload}->>'error'`.mapWith(
    nullableDriverValueDecoder(chatEvents.error),
  );
}

/** Goal grouping exists only on the canonical goal context pointer. */
export function canonicalChatEventGoalId(
  contextType: SQLWrapper = chatEvents.contextType,
  contextId: SQLWrapper = chatEvents.contextId,
) {
  return sql`CASE
    WHEN ${contextType} = 'goal' THEN ${contextId}
    ELSE NULL
  END`.mapWith(nullableDriverValueDecoder(chatEvents.contextId));
}
