import { command, computed } from "ccstate";
import type { VoiceInputModelId } from "@okouai/api-contracts/contracts/voice-input-models";

import { updateUserPreference$, userPreferences$ } from "./user-preferences.ts";

export const voiceInputModelPreference$ = computed(async (get) => {
  const preferences = await get(userPreferences$);
  return preferences.voiceInputModel ?? null;
});

export const updateVoiceInputModelPreference$ = command(
  async ({ set }, model: VoiceInputModelId | null, signal: AbortSignal) => {
    await set(updateUserPreference$, { voiceInputModel: model }, signal);
  },
);
