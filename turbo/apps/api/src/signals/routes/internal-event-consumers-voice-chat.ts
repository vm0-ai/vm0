import { command } from "ccstate";
import type { VoiceChatTaskResultEntry } from "@vm0/api-contracts/contracts/zero-voice-chat";
import { internalEventConsumerVoiceChatContract } from "@vm0/api-contracts/contracts/internal-event-consumers";

import {
  eventConsumerPayload$,
  eventConsumerRoute,
} from "../../lib/event-consumer/route";
import type { AgentEvent } from "../../lib/event-consumer/verify";
import { nowDate } from "../../lib/time";
import { publishUserSignal } from "../external/realtime";
import type { RouteEntry } from "../route";
import {
  appendVoiceChatTaskAssistantResult$,
  markVoiceChatTaskRunningIfQueued$,
} from "../services/zero-voice-chat.service";

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function eventText(event: AgentEvent): string | null {
  const message = recordOf(event.message);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    const record = recordOf(block);
    if (record?.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.length === 1 ? parts[0]! : parts.join("\n\n");
}

const processVoiceChatEvents$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const payload = get(eventConsumerPayload$);
    signal.throwIfAborted();

    const timestamp = nowDate().toISOString();
    const entries: VoiceChatTaskResultEntry[] = payload.events.flatMap(
      (event) => {
        const text = eventText(event);
        if (text === null) {
          return [];
        }
        return [{ type: "assistant", content: text, at: timestamp }];
      },
    );

    const running = await set(
      markVoiceChatTaskRunningIfQueued$,
      payload.runId,
      signal,
    );
    signal.throwIfAborted();

    const appended =
      entries.length > 0
        ? await set(
            appendVoiceChatTaskAssistantResult$,
            { runId: payload.runId, entries },
            signal,
          )
        : null;
    signal.throwIfAborted();

    const touch = running ?? appended;
    if (touch) {
      await publishUserSignal([touch.userId], `voice-chat:${touch.sessionId}`);
      signal.throwIfAborted();
    }

    return { status: 200 as const, body: { processed: entries.length } };
  },
);

export const internalEventConsumerVoiceChatRoutes: readonly RouteEntry[] = [
  {
    route: internalEventConsumerVoiceChatContract.process,
    handler: eventConsumerRoute(processVoiceChatEvents$),
  },
];
