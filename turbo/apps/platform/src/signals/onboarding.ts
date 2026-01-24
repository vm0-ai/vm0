import { command, computed, state } from "ccstate";
import { initScope$ } from "./scope.ts";

/**
 * Internal state for onboarding modal visibility.
 */
const internalShowOnboardingModal$ = state(false);

/**
 * Internal state for OAuth token value.
 */
const internalTokenValue$ = state("");

/**
 * Internal state for copy status.
 */
const internalCopyStatus$ = state<"idle" | "copied">("idle");

/**
 * Whether the onboarding modal is currently shown.
 */
export const showOnboardingModal$ = computed((get) =>
  get(internalShowOnboardingModal$),
);

/**
 * Current OAuth token value.
 */
export const tokenValue$ = computed((get) => get(internalTokenValue$));

/**
 * Current copy status.
 */
export const copyStatus$ = computed((get) => get(internalCopyStatus$));

/**
 * Whether the Save button should be enabled.
 * Requires a non-empty token value.
 */
export const canSaveOnboarding$ = computed((get) => {
  const tokenValue = get(internalTokenValue$);
  return tokenValue.trim().length > 0;
});

/**
 * Set the OAuth token value.
 */
export const setTokenValue$ = command(({ set }, value: string) => {
  set(internalTokenValue$, value);
});

/**
 * Internal state for copy timeout id.
 */
const internalCopyTimeoutId$ = state<number | null>(null);

/**
 * Copy text to clipboard and show "copied" status for 5 seconds.
 */
export const copyToClipboard$ = command(({ get, set }, text: string) => {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      // Clear any existing timeout
      const existingTimeoutId = get(internalCopyTimeoutId$);
      if (existingTimeoutId !== null) {
        window.clearTimeout(existingTimeoutId);
      }

      set(internalCopyStatus$, "copied");

      // Reset after 5 seconds
      const timeoutId = window.setTimeout(() => {
        set(internalCopyStatus$, "idle");
        set(internalCopyTimeoutId$, null);
      }, 5000);
      set(internalCopyTimeoutId$, timeoutId);
    })
    .catch(() => {
      // Clipboard access may fail in some environments
    });
});

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

/**
 * Save the onboarding configuration.
 */
export const saveOnboardingConfig$ = command(({ set }) => {
  // TODO: Save the configuration to backend
  set(internalShowOnboardingModal$, false);
});
