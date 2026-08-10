import {
  CHAT_EVENT_CONTENT_TEXT_TYPES,
  CHAT_EVENT_USER_MESSAGE_TEXT_TYPES,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";
import { chatEvents } from "@vm0/db/schema/chat-event";
import {
  and,
  eq,
  inArray,
  isNotNull,
  not,
  or,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

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
 * Match the input event that owns an ingress dispatch. Keeping the event-type
 * guard in this shared predicate prevents a control.interrupt row whose
 * canonical run_id points at the same run from being treated as the ingress
 * input by Feishu, AgentPhone, Teams, or Telegram dispatch readers.
 */
export function chatInputPromptDispatchCondition(args: {
  readonly eventId: string;
  readonly chatThreadId?: string;
}): SQL {
  return and(
    args.chatThreadId === undefined
      ? undefined
      : eq(chatEvents.chatThreadId, args.chatThreadId),
    chatEventTypeIn(["input.prompt"]),
    or(
      eq(chatEvents.id, args.eventId),
      eq(chatEvents.revokesEventId, args.eventId),
    ),
  ) as SQL;
}

/**
 * During the canonical-schema rollout, control interrupts store their target
 * run in run_id. Legacy readers must not mistake that pointer for ordinary run
 * ownership until they switch to the canonical event-type-aware model. This
 * protects DB/API skew (observed maximum: about 102 minutes) and remains until
 * canonical readers replace run_id-as-ownership assumptions. Follow-up:
 * #26158.
 */
export function legacyRunOwnedChatEventCondition(): SQL {
  return not(chatEventTypeIn(["control.interrupt"]));
}

/** Shared collision-safe run lookup for artifact and thread readers. */
export function legacyRunOwnedChatEventForRunCondition(args: {
  readonly runId: string | SQLWrapper;
  readonly chatThreadId?: string;
}): SQL {
  return and(
    eq(chatEvents.runId, args.runId),
    args.chatThreadId === undefined
      ? undefined
      : eq(chatEvents.chatThreadId, args.chatThreadId),
    legacyRunOwnedChatEventCondition(),
  ) as SQL;
}
