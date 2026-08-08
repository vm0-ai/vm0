import type { ChatEvent } from "./chat-event-types.ts";

export function chatEventTraceTime(): number {
  return performance.now();
}

export function chatEventDebugSummaries(
  events: readonly ChatEvent[],
): readonly {
  readonly seqId: number | null;
  readonly id: string;
  readonly eventType: ChatEvent["eventType"];
  readonly runId: string | null;
  readonly createdAt: string;
  readonly optimisticAssociation: string | null;
  readonly contentPreview: string | null;
  readonly hasUserMessage: boolean;
}[] {
  return events.map((event) => {
    return {
      seqId: event.seqId ?? null,
      id: event.id,
      eventType: event.eventType,
      runId: event.runId ?? null,
      createdAt: event.createdAt,
      optimisticAssociation: event.optimisticUserMessageAssociation ?? null,
      contentPreview:
        typeof event.content === "string" ? event.content.slice(0, 120) : null,
      hasUserMessage: "userMessage" in event && event.userMessage !== undefined,
    };
  });
}
