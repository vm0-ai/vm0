import { command, computed, state } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import {
  createModelProvider$,
  modelProviders$,
} from "../external/model-providers.ts";

/**
 * Internal state for token value.
 */
const internalTokenValue$ = state("");

/**
 * Internal state for editing mode.
 */
const internalIsEditing$ = state(false);

/**
 * Token value for the settings page input.
 */
export const settingsTokenValue$ = computed((get) => get(internalTokenValue$));

/**
 * Whether the token input is in editing mode.
 */
export const settingsIsEditing$ = computed((get) => get(internalIsEditing$));

/**
 * Set the token value.
 */
export const setSettingsTokenValue$ = command(({ set }, value: string) => {
  set(internalTokenValue$, value);
});

/**
 * Set the editing state.
 */
export const setSettingsIsEditing$ = command(({ set }, value: boolean) => {
  set(internalIsEditing$, value);
});

/**
 * Mask for the existing token (e.g., "✳ sk-ant-oa...")
 */
export const existingTokenMask$ = computed(async (get) => {
  const { modelProviders } = await get(modelProviders$);
  const oauthProvider = modelProviders.find(
    (p) => p.type === "claude-code-oauth-token",
  );

  if (oauthProvider) {
    return "\u2733 sk-ant-oa...";
  }
  return "";
});

/**
 * Save the model provider with the current token value.
 */
export const saveModelProvider$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const tokenValue = get(internalTokenValue$);
    if (!tokenValue) {
      return;
    }

    await set(createModelProvider$, {
      type: "claude-code-oauth-token",
      credential: tokenValue,
    });
    signal.throwIfAborted();

    // Clear the input after saving
    set(internalTokenValue$, "");
    set(internalIsEditing$, false);
  },
);

/**
 * Cancel editing and reset the token input.
 */
export const cancelSettingsEdit$ = command(({ set }) => {
  set(internalTokenValue$, "");
  set(internalIsEditing$, false);
});

/**
 * Setup the settings page.
 */
export const setupSettingsPage$ = command(async ({ set }) => {
  const { SettingsPage } = await import(
    "../../views/settings-page/settings-page.tsx"
  );
  set(updatePage$, createElement(SettingsPage));
});
