import { command, computed, state } from "ccstate";
import {
  chatStreamDeltaPayloadSchema,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { nowDate } from "../../lib/time.ts";

interface StreamingDraftEntry {
  readonly threadId: string;
  readonly message: PagedChatMessage;
}

type AssistantRunLifecycleEvent = Extract<
  PagedChatMessage,
  { role: "assistant" }
>["runLifecycleEvent"];

function isTerminalRunLifecycleEvent(
  value: AssistantRunLifecycleEvent,
): value is NonNullable<AssistantRunLifecycleEvent> {
  return value === "completed" || value === "failed" || value === "cancelled";
}

const streamingDrafts$ = state<readonly StreamingDraftEntry[]>([]);

export function createStreamingDraftsForThread(threadId: string) {
  return computed((get): PagedChatMessage[] => {
    return get(streamingDrafts$).flatMap((entry) => {
      return entry.threadId === threadId ? [entry.message] : [];
    });
  });
}

export const applyStreamingDelta$ = command(
  ({ set }, args: { readonly threadId: string; readonly payload: unknown }) => {
    const payload = chatStreamDeltaPayloadSchema.parse(args.payload);
    if (payload.threadId !== args.threadId) {
      throw new Error("chat stream delta thread mismatch");
    }

    set(streamingDrafts$, (prev) => {
      const existingIndex = prev.findIndex((entry) => {
        return (
          entry.threadId === args.threadId &&
          entry.message.id === payload.messageId
        );
      });
      if (existingIndex === -1) {
        const message: PagedChatMessage = {
          id: payload.messageId,
          role: "assistant",
          content: payload.text,
          runId: payload.runId,
          runEventId: payload.runEventId,
          createdAt: nowDate().toISOString(),
        };
        return [
          ...prev,
          {
            threadId: args.threadId,
            message,
          },
        ];
      }

      return prev.map((entry, index) => {
        if (index !== existingIndex) {
          return entry;
        }
        return {
          ...entry,
          message: {
            ...entry.message,
            content: `${entry.message.content ?? ""}${payload.text}`,
          },
        };
      });
    });
  },
);

export const reconcileStreamingDrafts$ = command(
  (
    { set },
    args: {
      readonly threadId: string;
      readonly messages: readonly PagedChatMessage[];
    },
  ) => {
    const serverMessageIds = new Set(
      args.messages.map((message) => {
        return message.id;
      }),
    );
    const terminalRunIds = new Set(
      args.messages.flatMap((message) => {
        if (
          message.role !== "assistant" ||
          message.runId === undefined ||
          message.runLifecycleEvent === undefined ||
          !isTerminalRunLifecycleEvent(message.runLifecycleEvent)
        ) {
          return [];
        }
        return [message.runId];
      }),
    );

    if (serverMessageIds.size === 0 && terminalRunIds.size === 0) {
      return;
    }

    set(streamingDrafts$, (prev) => {
      return prev.filter((entry) => {
        if (entry.threadId !== args.threadId) {
          return true;
        }
        const runId = entry.message.runId;
        return (
          !serverMessageIds.has(entry.message.id) &&
          (runId === undefined || !terminalRunIds.has(runId))
        );
      });
    });
  },
);

export const clearStreamingDraftsForThread$ = command(
  ({ set }, threadId: string) => {
    set(streamingDrafts$, (prev) => {
      return prev.filter((entry) => {
        return entry.threadId !== threadId;
      });
    });
  },
);
