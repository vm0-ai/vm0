import {
  chatEventResponseSchema,
  type ChatMessageCompatibilityResponse,
  type ChatEventResponse,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";

type UnionKeys<T> = T extends unknown ? keyof T : never;
type UnionValue<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never;

type OptionalUnionFields<T> = {
  [K in UnionKeys<T>]?: UnionValue<T, K>;
};

export type MockChatEventInput =
  OptionalUnionFields<ChatMessageCompatibilityResponse> & {
    id?: string;
    role?: "user" | "assistant";
    content: string | null;
    createdAt: string;
  };

function inferredEventType(message: MockChatEventInput): ChatEventType {
  if (message.eventType !== undefined) {
    return message.eventType;
  }
  if (message.role === "user") {
    if (message.interruptsRunId !== undefined) {
      return "control.interrupt";
    }
    if (
      (message.revokesEventId !== undefined ||
        message.revokesMessageId !== undefined) &&
      message.content === null
    ) {
      return "control.revoke";
    }
    return message.error === undefined ? "input.prompt" : "input.rejected";
  }
  if (message.runLifecycleEvent === "completed") {
    return "run.completed";
  }
  if (message.runLifecycleEvent === "failed") {
    return "run.failed";
  }
  if (message.runLifecycleEvent === "cancelled") {
    return "run.cancelled";
  }
  if (message.runEventId === "queue:queued") {
    return "run.queued";
  }
  if (message.runEventId === "queue:dequeued") {
    return "run.dequeued";
  }
  if (message.goalEvent !== undefined) {
    return "goal.changed";
  }
  if (message.usage !== undefined) {
    return "usage.recorded";
  }
  if (message.recommendedFollowups !== undefined) {
    return "output.followups";
  }
  if (message.thinking !== undefined || message.content === null) {
    return "output.thinking";
  }
  return message.error === undefined ? "output.message" : "output.error";
}

function baseEvent(
  message: MockChatEventInput,
  id: string,
  content: string | null,
  fallbackSeqId: number,
) {
  const revokesEventId = message.revokesEventId ?? message.revokesMessageId;
  return {
    id,
    threadId: message.threadId ?? "00000000-0000-4000-8000-000000000001",
    content,
    runId: message.runId,
    runGroupId: message.runGroupId,
    triggerSource: message.triggerSource,
    slackMessagePermalink: message.slackMessagePermalink,
    feishuChatOpenUrl: message.feishuChatOpenUrl,
    isGoalRun: message.isGoalRun,
    runEventId: message.runEventId,
    goalSnapshot: message.goalSnapshot,
    revokesEventId,
    revokesMessageId: revokesEventId,
    seqId: message.seqId ?? fallbackSeqId,
    sequenceNumber: message.sequenceNumber,
    workflowSnapshot: message.workflowSnapshot,
    createdAt: message.createdAt,
  };
}

type MockChatEventOverrides = (
  message: MockChatEventInput,
  id: string,
) => Record<string, unknown>;

function requiredMockUserMessage(
  message: MockChatEventInput,
): UserMessageDocument {
  if (message.userMessage !== undefined) {
    return message.userMessage;
  }
  const parts: UserMessageDocument["parts"] = [
    ...(message.attachFiles ?? []).map((file) => {
      return {
        type: "file" as const,
        fileId: file.id,
        filenameSnapshot: file.filename,
        contentType: file.contentType,
      };
    }),
    ...(message.content
      ? [{ type: "text" as const, text: message.content }]
      : []),
  ];
  if (parts.length === 0) {
    throw new Error("Mock user-input events require a userMessage");
  }
  return { version: 1, parts };
}

const mockChatEventOverrides = {
  "input.prompt": (message) => {
    return {
      userMessage: requiredMockUserMessage(message),
      attachFiles: message.attachFiles,
      generationTemplate: message.generationTemplate,
    };
  },
  "input.automation": (message, id) => {
    return {
      content: null,
      automationId:
        message.automationId ?? "00000000-0000-4000-8000-000000000010",
      triggerSource: message.triggerSource ?? "workflow-event",
      triggerBrief:
        message.triggerBrief === undefined
          ? `Automation event ${id}`
          : message.triggerBrief,
    };
  },
  "input.rejected": (message) => {
    return {
      error: message.error ?? "Mock input rejected",
      userMessage: requiredMockUserMessage(message),
      attachFiles: message.attachFiles,
      generationTemplate: message.generationTemplate,
    };
  },
  "output.message": (message) => {
    return { content: message.content ?? "" };
  },
  "output.error": (message) => {
    return { error: message.error ?? "Mock output error" };
  },
  "output.thinking": (message) => {
    return {
      content: null,
      thinking: message.thinking ?? "",
    };
  },
  "output.followups": (message) => {
    return {
      content: null,
      recommendedFollowups: message.recommendedFollowups ?? [],
    };
  },
  "run.queued": (message, id) => {
    return {
      runId: message.runId ?? `mock-run-${id}`,
      content: message.content ?? "Waiting in queue...",
    };
  },
  "run.dequeued": (message, id) => {
    const revokesEventId =
      message.revokesEventId ?? message.revokesMessageId ?? `mock-queued-${id}`;
    return {
      runId: message.runId ?? `mock-run-${id}`,
      content: null,
      revokesEventId,
      revokesMessageId: revokesEventId,
    };
  },
  "run.completed": (message, id) => {
    return {
      runId: message.runId ?? `mock-run-${id}`,
      attachFiles: message.attachFiles,
      runLifecycleEvent: "completed",
    };
  },
  "run.failed": (message, id) => {
    return {
      runId: message.runId ?? `mock-run-${id}`,
      error: message.error,
      runLifecycleEvent: "failed",
    };
  },
  "run.cancelled": (message, id) => {
    return {
      runId: message.runId ?? `mock-run-${id}`,
      error: message.error,
      runLifecycleEvent: "cancelled",
    };
  },
  "queue.automation_paused": (message) => {
    return {
      content: null,
      pauseReason: message.pauseReason ?? null,
    };
  },
  "queue.automation_resumed": () => {
    return { content: null };
  },
  "control.interrupt": (message, id) => {
    return {
      content: null,
      interruptsRunId: message.interruptsRunId ?? `mock-interrupted-run-${id}`,
    };
  },
  "control.revoke": (message, id) => {
    const revokesEventId =
      message.revokesEventId ??
      message.revokesMessageId ??
      `mock-revoked-${id}`;
    return {
      content: null,
      revokesEventId,
      revokesMessageId: revokesEventId,
    };
  },
  "goal.changed": (message) => {
    return {
      content: null,
      goalEvent: message.goalEvent,
    };
  },
  "usage.recorded": (message, id) => {
    return {
      runId: message.runId ?? `mock-run-${id}`,
      content: null,
      usage: message.usage,
    };
  },
} satisfies Record<ChatEventType, MockChatEventOverrides>;

function normalizeMockChatEvent(
  message: MockChatEventInput,
  fallbackId: string,
  fallbackSeqId = 1,
): ChatEventResponse {
  const id = message.id ?? fallbackId;
  const eventType = inferredEventType(message);
  return chatEventResponseSchema.parse({
    ...baseEvent(message, id, message.content, fallbackSeqId),
    eventType,
    role: chatEventCompatibilityRole(eventType),
    ...mockChatEventOverrides[eventType](message, id),
  });
}

export function normalizeMockChatEvents(
  messages: readonly MockChatEventInput[],
): ChatEventResponse[] {
  let nextSeqId = 1;
  return messages.flatMap((message, index) => {
    const fallbackId = `mock-chat-event-${index.toString()}`;
    const seqId = message.seqId ?? nextSeqId;
    nextSeqId = Math.max(nextSeqId, seqId + 1);
    if (
      message.recommendedFollowups !== undefined &&
      message.runLifecycleEvent !== undefined
    ) {
      const terminal = normalizeMockChatEvent(
        { ...message, recommendedFollowups: undefined },
        fallbackId,
        seqId,
      );
      const followups = normalizeMockChatEvent(
        {
          ...message,
          id: `${terminal.id}:followups`,
          seqId: nextSeqId,
          content: null,
          error: undefined,
          runLifecycleEvent: undefined,
          eventType: "output.followups",
        },
        `${fallbackId}:followups`,
        nextSeqId,
      );
      nextSeqId += 1;
      return [terminal, followups];
    }
    return [normalizeMockChatEvent(message, fallbackId, seqId)];
  });
}
