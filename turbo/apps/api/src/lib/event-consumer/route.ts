import { computed, state } from "ccstate";

import type { EventConsumerPayload } from "./verify";

/**
 * Backing store for {@link eventConsumerPayload$}. In-process callers (e.g.
 * the agent events webhook) set this with an already-trusted payload before
 * calling an event-consumer command directly.
 */
export const eventConsumerPayloadState$ = state<EventConsumerPayload | null>(
  null,
);

/**
 * Parsed event-consumer payload. Follows the same set/read pattern as
 * `authContext$`.
 */
export const eventConsumerPayload$ = computed((get): EventConsumerPayload => {
  const payload = get(eventConsumerPayloadState$);
  if (!payload) {
    throw new Error(
      "eventConsumerPayload$ accessed outside an eventConsumerRoute scope",
    );
  }
  return payload;
});
