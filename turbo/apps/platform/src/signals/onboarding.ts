import { command, computed, state } from "ccstate";
import { initScope$, hasScope$ } from "./scope.ts";
import {
  hasClaudeCodeOAuthToken$,
  createModelProvider$,
} from "./external/model-providers.ts";

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
 * Whether the user needs to complete onboarding.
 * Returns true if scope is missing OR claude-code-oauth-token is missing.
 */
export const needsOnboarding$ = computed(async (get) => {
  const scopeExists = await get(hasScope$);
  const hasOAuthToken = await get(hasClaudeCodeOAuthToken$);
  return !scopeExists || !hasOAuthToken;
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
 * Start the onboarding flow - show modal only.
 * Scope and model provider creation is deferred to save action.
 */
export const startOnboarding$ = command(({ set }) => {
  set(internalShowOnboardingModal$, true);
});

/**
 * Close the onboarding modal (Add it later).
 * Creates scope if needed but skips model provider creation.
 */
export const closeOnboardingModal$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Create scope if it doesn't exist
    const scopeExists = await get(hasScope$);
    signal.throwIfAborted();

    if (!scopeExists) {
      await set(initScope$, signal);
      signal.throwIfAborted();
    }

    // Clear token and close modal
    set(internalTokenValue$, "");
    set(internalShowOnboardingModal$, false);
  },
);

/**
 * Save the onboarding configuration.
 * Creates scope if needed and creates the model provider with OAuth token.
 */
export const saveOnboardingConfig$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Get token value
    const tokenValue = get(internalTokenValue$);
    if (!tokenValue.trim()) {
      return;
    }

    // Create scope if it doesn't exist
    const scopeExists = await get(hasScope$);
    signal.throwIfAborted();

    if (!scopeExists) {
      await set(initScope$, signal);
      signal.throwIfAborted();
    }

    // Create model provider with OAuth token
    await set(createModelProvider$, {
      type: "claude-code-oauth-token",
      credential: tokenValue.trim(),
    });
    signal.throwIfAborted();

    // Clear token and close modal
    set(internalTokenValue$, "");
    set(internalShowOnboardingModal$, false);
  },
);
