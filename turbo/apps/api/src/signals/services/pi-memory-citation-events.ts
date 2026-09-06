import {
  mergePiMemoryCitations,
  parsePiMemoryCitation,
  projectPiMemoryCitationSegments,
  projectPiMemoryCitationText,
  type PiMemoryCitation,
} from "@okouai/api-contracts/contracts/pi-memory-citations";

import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";

export interface EventCitation {
  readonly sequenceNumber: number;
  readonly citation: PiMemoryCitation;
}

interface NormalizedRunOutputEvents {
  readonly payload: EventConsumerPayload;
  readonly citations: readonly EventCitation[];
}

function citationSignature(citation: PiMemoryCitation): string {
  return JSON.stringify([
    citation.entries.map(({ path, lineStart, lineEnd, note }) => {
      return [path, lineStart, lineEnd, note];
    }),
    citation.rolloutIds,
  ]);
}

interface NormalizedEvent {
  event: AgentEvent;
  citation?: PiMemoryCitation;
}

interface AssistantTextReference {
  readonly eventIndex: number;
  readonly blockIndex: number;
  readonly text: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function hasMemoryCitation(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, "memoryCitation");
}

function withoutMemoryCitation(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const { memoryCitation: _memoryCitation, ...rest } = value;
  return rest;
}

function withoutEventMemoryCitation(event: AgentEvent): AgentEvent {
  return {
    ...withoutMemoryCitation(event),
    type: event.type,
    sequenceNumber: event.sequenceNumber,
  };
}

function normalizeAssistantEvent(event: AgentEvent): {
  readonly event: AgentEvent;
  readonly citation?: PiMemoryCitation;
} {
  const message = recordOf(event.message);
  if (!message) {
    const citation = parsePiMemoryCitation(event.memoryCitation);
    const changed = hasMemoryCitation(event);
    return {
      event: changed ? withoutEventMemoryCitation(event) : event,
      ...(citation ? { citation } : {}),
    };
  }
  const suppliedCitation = mergePiMemoryCitations(
    parsePiMemoryCitation(message.memoryCitation),
    parsePiMemoryCitation(event.memoryCitation),
  );
  const messageChanged = hasMemoryCitation(message);
  const eventChanged = hasMemoryCitation(event);
  if (!messageChanged && !eventChanged) {
    return { event };
  }
  return {
    event: {
      ...(eventChanged ? withoutEventMemoryCitation(event) : event),
      message: messageChanged ? withoutMemoryCitation(message) : message,
    },
    ...(suppliedCitation ? { citation: suppliedCitation } : {}),
  };
}

function assistantMessageId(event: AgentEvent): string | null {
  const message = recordOf(event.message);
  return typeof message?.id === "string" ? message.id : null;
}

function assistantTextReferences(
  events: NormalizedEvent[],
  indexes: readonly number[],
): AssistantTextReference[] {
  const references: AssistantTextReference[] = [];
  for (const eventIndex of indexes) {
    const normalized = events[eventIndex];
    const message = normalized ? recordOf(normalized.event.message) : null;
    if (!message || !Array.isArray(message.content)) {
      continue;
    }
    for (const [blockIndex, block] of message.content.entries()) {
      const record = recordOf(block);
      if (record?.type === "text" && typeof record.text === "string") {
        references.push({ eventIndex, blockIndex, text: record.text });
      }
    }
  }
  return references;
}

function applyVisibleAssistantText(
  events: NormalizedEvent[],
  references: readonly AssistantTextReference[],
  visibleSegments: readonly string[],
): void {
  const contentByEvent = new Map<number, unknown[]>();
  for (const [textIndex, reference] of references.entries()) {
    const normalized = events[reference.eventIndex];
    const message = normalized ? recordOf(normalized.event.message) : null;
    if (!normalized || !message || !Array.isArray(message.content)) {
      continue;
    }
    const content = contentByEvent.get(reference.eventIndex) ?? [
      ...message.content,
    ];
    const block = recordOf(content[reference.blockIndex]);
    if (block) {
      content[reference.blockIndex] = {
        ...block,
        text: visibleSegments[textIndex] ?? "",
      };
    }
    contentByEvent.set(reference.eventIndex, content);
  }
  for (const [eventIndex, content] of contentByEvent) {
    const normalized = events[eventIndex];
    const message = normalized ? recordOf(normalized.event.message) : null;
    if (normalized && message) {
      normalized.event = {
        ...normalized.event,
        message: { ...message, content },
      };
    }
  }
}

function projectAssistantGroup(
  events: NormalizedEvent[],
  indexes: readonly number[],
): void {
  const references = assistantTextReferences(events, indexes);
  const projection = projectPiMemoryCitationSegments(
    references.map(({ text }) => {
      return text;
    }),
  );
  applyVisibleAssistantText(events, references, projection.visibleSegments);
  const finalIndex = indexes.at(-1);
  const finalEvent = finalIndex === undefined ? undefined : events[finalIndex];
  if (finalEvent) {
    finalEvent.citation = mergePiMemoryCitations(
      finalEvent.citation,
      projection.citation,
    );
  }
}

function projectAssistantGroups(events: NormalizedEvent[]): void {
  let group: number[] = [];
  let groupId: string | null = null;
  const flush = (): void => {
    if (group.length > 0) {
      projectAssistantGroup(events, group);
    }
    group = [];
    groupId = null;
  };
  for (const [index, { event }] of events.entries()) {
    if (event.type !== "assistant") {
      flush();
      continue;
    }
    const id = assistantMessageId(event);
    if (group.length > 0 && id !== groupId) {
      flush();
    }
    groupId = id;
    group.push(index);
  }
  flush();
}

function normalizeResultEvent(
  event: AgentEvent,
  parseHiddenText: boolean,
): { readonly event: AgentEvent; readonly citation?: PiMemoryCitation } {
  let citation = mergePiMemoryCitations(
    parsePiMemoryCitation(event.memoryCitation),
    undefined,
  );
  let changed = hasMemoryCitation(event);
  let normalized: AgentEvent = changed
    ? withoutEventMemoryCitation(event)
    : event;
  if (parseHiddenText && typeof event.result === "string") {
    const projection = projectPiMemoryCitationText(event.result);
    citation = mergePiMemoryCitations(citation, projection.citation);
    normalized = { ...normalized, result: projection.visibleText };
    changed = true;
  }
  const eventData = recordOf(event.eventData);
  if (parseHiddenText && eventData && typeof eventData.result === "string") {
    const projection = projectPiMemoryCitationText(eventData.result);
    citation = mergePiMemoryCitations(citation, projection.citation);
    normalized = {
      ...normalized,
      eventData: { ...eventData, result: projection.visibleText },
    };
    changed = true;
  }
  return {
    event: changed ? normalized : event,
    ...(citation ? { citation } : {}),
  };
}

/**
 * Normalize one admitted event batch. Pi text is parsed statefully across the
 * blocks of each semantic assistant message; supplied metadata is bounded for
 * every framework.
 */
export function normalizeRunOutputEvents(
  payload: EventConsumerPayload,
  parseHiddenText: boolean,
  suppliedCitations: readonly EventCitation[] = [],
): NormalizedRunOutputEvents {
  const suppliedBySequence = new Map(
    suppliedCitations.map((item) => {
      return [item.sequenceNumber, item.citation] as const;
    }),
  );
  const normalizedEvents: NormalizedEvent[] = payload.events.map((event) => {
    const normalized =
      event.type === "assistant"
        ? normalizeAssistantEvent(event)
        : event.type === "result"
          ? normalizeResultEvent(event, parseHiddenText)
          : { event };
    const supplied = suppliedBySequence.get(event.sequenceNumber);
    return {
      ...normalized,
      ...(supplied
        ? {
            citation: mergePiMemoryCitations(normalized.citation, supplied),
          }
        : {}),
    };
  });
  if (parseHiddenText) {
    projectAssistantGroups(normalizedEvents);
  }

  const citations: EventCitation[] = [];
  let lastAssistantCitationSignature: string | undefined;
  for (const normalized of normalizedEvents) {
    const signature = normalized.citation
      ? citationSignature(normalized.citation)
      : undefined;
    if (normalized.event.type === "assistant") {
      lastAssistantCitationSignature = signature;
    }
    if (
      !normalized.citation ||
      (normalized.event.type === "result" &&
        signature === lastAssistantCitationSignature)
    ) {
      continue;
    }
    citations.push({
      sequenceNumber: normalized.event.sequenceNumber,
      citation: normalized.citation,
    });
  }
  return {
    payload: {
      ...payload,
      events: normalizedEvents.map(({ event }) => {
        return event;
      }),
    },
    citations,
  };
}
