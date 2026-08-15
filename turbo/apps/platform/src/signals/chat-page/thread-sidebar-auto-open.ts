import { computed, type Computed } from "ccstate";

import type { ChatEvent } from "./chat-event-types.ts";

interface ThreadSidebarAutoOpenCandidate {
  readonly type: "browser";
  readonly resourceKey: string;
}

interface RawChatEventProjection {
  readonly event: ChatEvent;
}

export function createThreadSidebarAutoOpenCandidate(
  rawEvents$: Computed<readonly RawChatEventProjection[]>,
): Computed<ThreadSidebarAutoOpenCandidate | null> {
  return computed((get) => {
    let activeOpenEventId: string | null = null;
    for (const { event } of get(rawEvents$)) {
      if (event.eventType === "browser.open") {
        activeOpenEventId = event.id;
      } else if (event.eventType === "browser.close") {
        activeOpenEventId = null;
      }
    }
    return activeOpenEventId === null
      ? null
      : { type: "browser", resourceKey: activeOpenEventId };
  });
}

export function threadSidebarAutoOpenCandidateKey(
  candidate: ThreadSidebarAutoOpenCandidate,
): string {
  return `${candidate.type}:${candidate.resourceKey}`;
}
