import { command, computed, state } from "ccstate";
import {
  type AvatarSvgConfig,
  randomAvatarSvgConfig,
} from "../../../views/zero-page/avatar-svg-utils.ts";

export type Step =
  | "rotation"
  | "skin"
  | "hairStyle"
  | "hairColor"
  | "expression"
  | "intensity";

export const AVATAR_MAKER_STEPS = [
  { key: "rotation", label: "Angle" },
  { key: "skin", label: "Skin" },
  { key: "hairStyle", label: "Hair" },
  { key: "hairColor", label: "Color" },
  { key: "expression", label: "Face" },
  { key: "intensity", label: "Mood" },
] as const;

export const INTENSITY_LABELS = {
  d: "Chill",
  m: "Normal",
  h: "Hyped",
} as const;

// ---------------------------------------------------------------------------
// Dialog open state
// ---------------------------------------------------------------------------

const internalOpen$ = state(false);
export const avatarMakerOpen$ = computed((get) => {
  return get(internalOpen$);
});

// ---------------------------------------------------------------------------
// Avatar config state
// ---------------------------------------------------------------------------

const internalConfig$ = state<AvatarSvgConfig>(randomAvatarSvgConfig());
export const avatarMakerConfig$ = computed((get) => {
  return get(internalConfig$);
});

// ---------------------------------------------------------------------------
// Current step
// ---------------------------------------------------------------------------

const internalStep$ = state<Step>("rotation");
export const avatarMakerStep$ = computed((get) => {
  return get(internalStep$);
});

export const avatarMakerStepIdx$ = computed((get) => {
  const step = get(internalStep$);
  return AVATAR_MAKER_STEPS.findIndex((s) => {
    return s.key === step;
  });
});

// ---------------------------------------------------------------------------
// Just-picked state (for animation feedback)
// ---------------------------------------------------------------------------

const internalJustPicked$ = state<string | null>(null);
export const avatarMakerJustPicked$ = computed((get) => {
  return get(internalJustPicked$);
});

// ---------------------------------------------------------------------------
// Show sparkles state (separate from justPicked for animation timing)
// ---------------------------------------------------------------------------

const internalShowSparkles$ = state(false);
export const avatarMakerShowSparkles$ = computed((get) => {
  return get(internalShowSparkles$);
});

// ---------------------------------------------------------------------------
// Shuffling state (dice animation)
// ---------------------------------------------------------------------------

const internalShuffling$ = state(false);
export const avatarMakerShuffling$ = computed((get) => {
  return get(internalShuffling$);
});

// ---------------------------------------------------------------------------
// Saving state
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);
export const avatarMakerSaving$ = computed((get) => {
  return get(internalSaving$);
});
export const setAvatarMakerSaving$ = command(({ set }, value: boolean) => {
  set(internalSaving$, value);
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Randomize the avatar config with dice animation and sparkles. */
export const shuffleAvatar$ = command(({ set }) => {
  set(internalConfig$, randomAvatarSvgConfig());
  set(internalShuffling$, true);
  set(internalShowSparkles$, true);
  window.setTimeout(() => {
    set(internalShuffling$, false);
    set(internalShowSparkles$, false);
  }, 600);
});

/** Open the dialog with a fresh random avatar. */
export const openAvatarMaker$ = command(({ set }) => {
  set(internalConfig$, randomAvatarSvgConfig());
  set(internalStep$, "rotation");
  set(internalJustPicked$, null);
  set(internalShowSparkles$, false);
  set(internalShuffling$, false);
  set(internalOpen$, true);
});

/** Select an option for the current step. Auto-advances after a delay. */
export const selectAvatarOption$ = command(
  ({ get, set }, field: Step, value: number | string) => {
    set(internalJustPicked$, `${field}-${value}`);
    set(internalShowSparkles$, true);
    const prev = get(internalConfig$);
    set(internalConfig$, { ...prev, [field]: value });

    window.setTimeout(() => {
      set(internalJustPicked$, null);
      set(internalShowSparkles$, false);
      const idx = AVATAR_MAKER_STEPS.findIndex((s) => {
        return s.key === field;
      });
      if (idx + 1 < AVATAR_MAKER_STEPS.length) {
        set(internalStep$, AVATAR_MAKER_STEPS[idx + 1]!.key);
      }
    }, 350);
  },
);

/** Go back one step. */
export const goBackStep$ = command(({ get, set }) => {
  const idx = get(avatarMakerStepIdx$);
  if (idx > 0) {
    set(internalStep$, AVATAR_MAKER_STEPS[idx - 1]!.key);
  }
});

/** Go forward one step. */
export const goForwardStep$ = command(({ get, set }) => {
  const idx = get(avatarMakerStepIdx$);
  if (idx + 1 < AVATAR_MAKER_STEPS.length) {
    set(internalStep$, AVATAR_MAKER_STEPS[idx + 1]!.key);
  }
});

/** Close the dialog. */
export const closeAvatarMaker$ = command(({ set }) => {
  set(internalOpen$, false);
  set(internalShowSparkles$, false);
  set(internalJustPicked$, null);
});
