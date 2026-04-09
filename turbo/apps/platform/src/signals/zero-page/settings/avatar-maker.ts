import { command, computed, state } from "ccstate";
import {
  type AvatarSvgConfig,
  randomAvatarSvgConfig,
} from "../../../views/zero-page/avatar-svg-utils.ts";

type Step =
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
// Commands
// ---------------------------------------------------------------------------

/** Open the dialog, optionally seeding from an existing config. */
export const openAvatarMaker$ = command(
  ({ set }, initialConfig: AvatarSvgConfig | null) => {
    set(internalConfig$, initialConfig ?? randomAvatarSvgConfig());
    set(internalStep$, "rotation");
    set(internalJustPicked$, null);
    set(internalOpen$, true);
  },
);

/** Select an option for the current step. Auto-advances after a delay. */
export const selectAvatarOption$ = command(
  ({ get, set }, field: Step, value: number | string) => {
    set(internalJustPicked$, `${field}-${value}`);
    const prev = get(internalConfig$);
    set(internalConfig$, { ...prev, [field]: value });

    window.setTimeout(() => {
      set(internalJustPicked$, null);
      const idx = AVATAR_MAKER_STEPS.findIndex((s) => {
        return s.key === field;
      });
      if (idx + 1 < AVATAR_MAKER_STEPS.length) {
        set(internalStep$, AVATAR_MAKER_STEPS[idx + 1]!.key);
      }
    }, 300);
  },
);

/** Go back one step. */
export const goBackStep$ = command(({ get, set }) => {
  const idx = get(avatarMakerStepIdx$);
  if (idx > 0) {
    set(internalStep$, AVATAR_MAKER_STEPS[idx - 1]!.key);
  }
});

/** Close the dialog. */
export const closeAvatarMaker$ = command(({ set }) => {
  set(internalOpen$, false);
});
