import { command, computed, state } from "ccstate";
import { initScope$ } from "./scope.ts";

/**
 * Internal state for onboarding modal visibility.
 */
const internalShowOnboardingModal$ = state(false);

/**
 * Whether the onboarding modal is currently shown.
 */
export const showOnboardingModal$ = computed((get) =>
  get(internalShowOnboardingModal$),
);

/**
 * Start the onboarding flow - show modal and initialize scope.
 */
export const startOnboarding$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(internalShowOnboardingModal$, true);
    await set(initScope$, signal);
  },
);

/**
 * Close the onboarding modal.
 */
export const closeOnboardingModal$ = command(({ set }) => {
  set(internalShowOnboardingModal$, false);
});
