import { command, computed, state } from "ccstate";

export type MorningBriefUnsubscribeStatus = "unsubscribed" | "invalid";

/**
 * Result of the unsubscribe API call. Populated by the page setup before
 * `hideAppSkeleton$` fires so the view never renders a loading state.
 */
const internalStatus$ = state<MorningBriefUnsubscribeStatus | null>(null);

export const morningBriefUnsubscribeStatus$ = computed((get) => {
  return get(internalStatus$);
});

export const setMorningBriefUnsubscribeStatus$ = command(
  ({ set }, status: MorningBriefUnsubscribeStatus | null) => {
    set(internalStatus$, status);
  },
);
