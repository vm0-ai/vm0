import {
  CHAT_EVENT_CONTENT_TEXT_TYPES,
  CHAT_EVENT_USER_MESSAGE_TEXT_TYPES,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { and, inArray, isNotNull, not, or, type SQL } from "drizzle-orm";

export function chatEventTypeIn(eventTypes: readonly ChatEventType[]): SQL {
  return inArray(chatEvents.eventType, [...eventTypes]);
}

export function chatEventTextCondition(): SQL {
  return or(
    and(
      chatEventTypeIn(CHAT_EVENT_USER_MESSAGE_TEXT_TYPES),
      isNotNull(chatEvents.userMessage),
    ),
    and(
      chatEventTypeIn(CHAT_EVENT_CONTENT_TEXT_TYPES),
      isNotNull(chatEvents.content),
    ),
  ) as SQL;
}

/**
 * During the canonical-schema rollout, control interrupts store their target
 * run in run_id. Legacy readers must not mistake that pointer for ordinary run
 * ownership until they switch to the canonical event-type-aware model.
 */
export function legacyRunOwnedChatEventCondition(): SQL {
  return not(chatEventTypeIn(["control.interrupt"]));
}
