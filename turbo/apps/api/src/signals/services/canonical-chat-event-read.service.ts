import { userMessageDocumentSchema } from "@vm0/api-contracts/contracts/chat-threads";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { sql, type SQLWrapper } from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";

const chatEventUserMessageDecoder = zodDriverValueDecoder(
  userMessageDocumentSchema,
);

/** Canonical payload leaves projected from chat_events.payload. */
export function canonicalChatEventContent(
  payload: SQLWrapper = chatEvents.payload,
) {
  return sql`${payload}->>'content'`.mapWith(
    nullableDriverValueDecoder(pgTextDecoder),
  );
}

export function canonicalChatEventUserMessage(
  payload: SQLWrapper = chatEvents.payload,
) {
  return sql`${payload}->'userMessage'`.mapWith(
    nullableDriverValueDecoder(chatEventUserMessageDecoder),
  );
}

export function canonicalChatEventError(
  payload: SQLWrapper = chatEvents.payload,
) {
  return sql`${payload}->>'error'`.mapWith(
    nullableDriverValueDecoder(pgTextDecoder),
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
