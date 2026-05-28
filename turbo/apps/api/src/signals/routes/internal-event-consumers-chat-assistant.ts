import { command } from "ccstate";
import { internalEventConsumerChatAssistantContract } from "@vm0/api-contracts/contracts/internal-event-consumers";

import {
  eventConsumerPayload$,
  eventConsumerRoute,
} from "../../lib/event-consumer/route";
import type { AgentEvent } from "../../lib/event-consumer/verify";
import type { RouteEntry } from "../route";
import {
  chatThreadForRun,
  insertAssistantEventMessages$,
} from "../services/zero-chat-thread.service";

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function anthropicMessageText(event: AgentEvent): string | null {
  const message = recordOf(event.message);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    const record = recordOf(block);
    if (
      record?.type === "text" &&
      typeof record.text === "string" &&
      record.text.trim().length > 0
    ) {
      parts.push(record.text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.length === 1 ? parts[0]! : parts.join("\n\n");
}

function codexAgentMessageText(event: AgentEvent): string | null {
  if (event.type !== "item.completed") {
    return null;
  }
  const item = recordOf(event.item);
  if (
    item?.type !== "agent_message" ||
    typeof item.text !== "string" ||
    item.text.trim().length === 0
  ) {
    return null;
  }
  return item.text;
}

function eventText(event: AgentEvent): string | null {
  const fromMessage = anthropicMessageText(event);
  if (fromMessage !== null) {
    return fromMessage;
  }
  return codexAgentMessageText(event);
}

function eventMessageId(event: AgentEvent): string | undefined {
  const message = recordOf(event.message);
  if (typeof message?.id === "string") {
    return message.id;
  }

  const item = recordOf(event.item);
  if (typeof item?.id === "string") {
    return item.id;
  }

  return undefined;
}

const processChatAssistantEvents$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const payload = get(eventConsumerPayload$);
    signal.throwIfAborted();

    const items = payload.events.flatMap((event) => {
      const text = eventText(event);
      if (text === null) {
        return [];
      }
      return [
        {
          sequenceNumber: event.sequenceNumber,
          content: text,
          runEventId: eventMessageId(event),
        },
      ];
    });

    if (items.length === 0) {
      return { status: 200 as const, body: { processed: 0 } };
    }

    const thread = await get(chatThreadForRun(payload.runId));
    signal.throwIfAborted();
    if (!thread) {
      return { status: 200 as const, body: { processed: 0 } };
    }

    const written = await set(
      insertAssistantEventMessages$,
      {
        runId: payload.runId,
        threadId: thread.chatThreadId,
        userId: thread.userId,
        items,
      },
      signal,
    );
    signal.throwIfAborted();

    return { status: 200 as const, body: { processed: written } };
  },
);

export const internalEventConsumerChatAssistantRoutes: readonly RouteEntry[] = [
  {
    route: internalEventConsumerChatAssistantContract.process,
    handler: eventConsumerRoute(processChatAssistantEvents$),
  },
];
