import { command, computed, state } from "ccstate";
import {
  morningBriefPreferenceContract,
  MORNING_BRIEF_PREFERENCES_FOCUS,
  type MorningBriefPreferenceErrorCode,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import type { SendMode } from "@okouai/api-contracts/contracts/user-preferences";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { updateUserPreference$, userPreferences$ } from "./user-preferences.ts";
import { sendMode$ } from "../../send-mode.ts";
import { searchParams$, updateSearchParams$ } from "../../route.ts";
import { reloadPersonalModelProviders$ } from "../../external/personal-model-providers.ts";
import { onRef } from "../../utils.ts";

// ---------------------------------------------------------------------------
// Preferences tab state
// ---------------------------------------------------------------------------

export type PreferencesTab =
  | "appearance"
  | "timezone"
  | "model-configuration"
  | "debug";

const DEFAULT_PREFERENCES_TAB: PreferencesTab = "appearance";

function normalizePreferencesTab(value: string | null): PreferencesTab {
  if (value === "personal-providers") {
    return "model-configuration";
  }
  if (
    value === "timezone" ||
    value === "model-configuration" ||
    value === "debug"
  ) {
    return value;
  }
  return DEFAULT_PREFERENCES_TAB;
}

export const preferencesTab$ = computed((get) => {
  return normalizePreferencesTab(get(searchParams$).get("tab"));
});

export const setPreferencesTab$ = command(({ get, set }, value: string) => {
  const tab = normalizePreferencesTab(value);
  if (tab === "model-configuration") {
    set(reloadPersonalModelProviders$);
  }
  const next = new URLSearchParams(get(searchParams$));
  if (tab === DEFAULT_PREFERENCES_TAB) {
    next.delete("tab");
  } else {
    next.set("tab", tab);
  }
  set(updateSearchParams$, next);
});

// ---------------------------------------------------------------------------
// Morning Brief
// ---------------------------------------------------------------------------

export type MorningBriefPreferenceState =
  | {
      readonly kind: "ready";
      readonly preference: MorningBriefPreferenceResponse;
    }
  | {
      readonly kind: "error";
      readonly code: MorningBriefPreferenceErrorCode;
      readonly message: string;
    };

const morningBriefPreferenceVersion$ = state(0);

function preferenceState(
  result:
    | { readonly status: 200; readonly body: MorningBriefPreferenceResponse }
    | {
        readonly status: 400 | 409;
        readonly body: {
          readonly error: {
            readonly code: MorningBriefPreferenceErrorCode;
            readonly message: string;
          };
        };
      },
): MorningBriefPreferenceState {
  return result.status === 200
    ? { kind: "ready", preference: result.body }
    : {
        kind: "error",
        code: result.body.error.code,
        message: result.body.error.message,
      };
}

export const morningBriefPreference$ = computed(async (get) => {
  get(morningBriefPreferenceVersion$);
  const client = get(apiClient$)(morningBriefPreferenceContract);
  const result = await accept(client.get(), [200, 409]);
  return preferenceState(result);
});

export const updateMorningBriefPreference$ = command(
  async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
    const client = get(apiClient$)(morningBriefPreferenceContract);
    const result = await accept(
      client.update({
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200, 400, 409],
    );
    signal.throwIfAborted();
    set(morningBriefPreferenceVersion$, (version) => {
      return version + 1;
    });
    return preferenceState(result);
  },
);

export const retryMorningBriefPreference$ = command(({ set }) => {
  set(morningBriefPreferenceVersion$, (version) => {
    return version + 1;
  });
});

export const morningBriefPreferenceCardRef$ = onRef(
  command(({ get }, element: HTMLElement, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (get(searchParams$).get("focus") !== MORNING_BRIEF_PREFERENCES_FOCUS) {
      return;
    }
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
  }),
);

// ---------------------------------------------------------------------------
// Send mode
// ---------------------------------------------------------------------------

/**
 * Tracks the send mode value most recently submitted via updateSendMode$.
 * Used by the view to show an optimistic spinner on the correct button.
 * Cleared automatically when the command completes or fails.
 */
const internalPendingSendMode$ = state<SendMode | null>(null);

export const pendingSendMode$ = computed((get) => {
  return get(internalPendingSendMode$);
});

/**
 * Update send mode preference. After saving, await the refetched value so the
 * UI never flashes back to the old value before the signal updates.
 */
export const updateSendMode$ = command(
  async ({ get, set }, value: SendMode, signal: AbortSignal) => {
    set(internalPendingSendMode$, value);
    await set(updateUserPreference$, { sendMode: value }, signal).finally(
      () => {
        set(internalPendingSendMode$, null);
      },
    );
    signal.throwIfAborted();
    // Await the refetched sendMode so the optimistic UI is consistent.
    await get(sendMode$);
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Capture network bodies
// ---------------------------------------------------------------------------

export const captureNetworkBodiesRemaining$ = computed(async (get) => {
  const prefs = await get(userPreferences$);
  return prefs.captureNetworkBodiesRemaining;
});

export const updateCaptureNetworkBodies$ = command(
  async ({ set }, remaining: number, signal: AbortSignal) => {
    await set(
      updateUserPreference$,
      { captureNetworkBodiesRemaining: remaining },
      signal,
    );
  },
);
