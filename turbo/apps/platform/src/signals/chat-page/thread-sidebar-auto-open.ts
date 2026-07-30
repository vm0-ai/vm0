import { computed, type Computed } from "ccstate";

import type { ChatEvent } from "./chat-event-types.ts";

export interface ThreadSidebarAutoOpenCandidate {
  readonly type: "browser";
  readonly resourceKey: string;
}

interface RawChatEventProjection {
  readonly event: ChatEvent;
}

export function createThreadSidebarAutoOpenCandidate(
  rawEvents$: Computed<readonly RawChatEventProjection[]>,
): Computed<Promise<ThreadSidebarAutoOpenCandidate | null>> {
  return computed((get) => {
    let activeStartEventId: string | null = null;
    for (const { event } of get(rawEvents$)) {
      if (event.eventType === "browser.started") {
        activeStartEventId = event.id;
      } else if (event.eventType === "browser.stopped") {
        activeStartEventId = null;
      }
    }
    return Promise.resolve(
      activeStartEventId === null
        ? null
        : { type: "browser", resourceKey: activeStartEventId },
    );
  });
}

export function threadSidebarAutoOpenCandidateKey(
  candidate: ThreadSidebarAutoOpenCandidate,
): string {
  return `${candidate.type}:${candidate.resourceKey}`;
}
