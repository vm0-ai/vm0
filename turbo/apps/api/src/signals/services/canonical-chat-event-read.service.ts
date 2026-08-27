import { userMessageDocumentSchema } from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";

import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";

const chatEventUserMessageDecoder = zodDriverValueDecoder(
  userMessageDocumentSchema,
);
const requiredOfficialWorkflowIdsDecoder = zodDriverValueDecoder(
  z
    .array(z.string().uuid())
    .min(1)
    .refine((workflowIds) => {
      return new Set(workflowIds).size === workflowIds.length;
    }, "Official Workflow source IDs must be unique"),
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

/** Validate the strict server-owned authority read from its private column. */
export function parseCanonicalChatEventRequiredOfficialWorkflowIds(
  workflowIds: readonly string[] | null,
): readonly string[] | null {
  return workflowIds === null
    ? null
    : requiredOfficialWorkflowIdsDecoder.mapFromDriverValue(workflowIds);
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

/** Canonical payload leaves projected from an archived raw row. */
export function canonicalArchivedChatEventContent(
  row: ChatEventRow,
): string | null {
  if (row.eventType === "output.tool") {
    return null;
  }
  return row.payload?.content ?? null;
}

export function canonicalArchivedChatEventUserMessage(row: ChatEventRow) {
  if (row.eventType === "output.tool") {
    return null;
  }
  const userMessage = row.payload?.userMessage;
  return userMessage === undefined
    ? null
    : userMessageDocumentSchema.parse(userMessage);
}

export function canonicalArchivedChatEventError(
  row: ChatEventRow,
): string | null {
  if (row.eventType === "output.tool") {
    return null;
  }
  return row.payload?.error ?? null;
}

export function canonicalArchivedChatEventGoalId(
  row: ChatEventRow,
): string | null {
  return row.contextType === "goal" ? row.contextId : null;
}
