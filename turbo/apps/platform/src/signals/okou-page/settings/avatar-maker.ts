import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import {
  updateAvatarComposerConfig,
  type AvatarComposerSelection,
} from "@okouai/core/agent-avatar";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  isLegacyAvatarSvgConfig,
  randomAvatarSvgConfig,
  randomLegacyAvatarSvgConfig,
  type LegacyAvatarSvgConfig,
  type ResolvedAvatarSvgConfig,
} from "../../../views/okou-page/avatar-svg-utils.ts";
import { resolveAvatarSvgConfig } from "../../../views/okou-page/avatar-utils.ts";
import {
  avatarNeckSweaterEnabled$,
  featureSwitch$,
} from "../../external/feature-switch.ts";

export type ComposerStep =
  | "face"
  | "hair"
  | "expression"
  | "skin"
  | "hairColor"
  | "sweater";
export type LegacyStep =
  | "rotation"
  | "skin"
  | "hairStyle"
  | "hairColor"
  | "expression"
  | "intensity";
export type Step = ComposerStep | LegacyStep;

type LegacyAvatarMakerSelection =
  | {
      readonly mode: "legacy";
      readonly field: "rotation";
      readonly value: number;
    }
  | { readonly mode: "legacy"; readonly field: "skin"; readonly value: number }
  | {
      readonly mode: "legacy";
      readonly field: "hairStyle";
      readonly value: number;
    }
  | {
      readonly mode: "legacy";
      readonly field: "hairColor";
      readonly value: number;
    }
  | {
      readonly mode: "legacy";
      readonly field: "expression";
      readonly value: number;
    }
  | {
      readonly mode: "legacy";
      readonly field: "intensity";
      readonly value: LegacyAvatarSvgConfig["intensity"];
    };

export type AvatarMakerSelection =
  | ({ readonly mode: "composer" } & AvatarComposerSelection)
  | LegacyAvatarMakerSelection;

const AVATAR_MAKER_STEPS: readonly Step[] = [
  "face",
  "hair",
  "expression",
  "skin",
  "hairColor",
];

const LEGACY_AVATAR_MAKER_STEPS: readonly Step[] = [
  "rotation",
  "skin",
  "hairStyle",
  "hairColor",
  "expression",
  "intensity",
];

function stepsForConfig(
  config: ResolvedAvatarSvgConfig,
  neckSweater: boolean,
): readonly Step[] {
  if (isLegacyAvatarSvgConfig(config)) {
    return LEGACY_AVATAR_MAKER_STEPS;
  }
  return neckSweater ? [...AVATAR_MAKER_STEPS, "sweater"] : AVATAR_MAKER_STEPS;
}

function updateLegacyConfig(
  config: LegacyAvatarSvgConfig,
  selection: LegacyAvatarMakerSelection,
): LegacyAvatarSvgConfig {
  switch (selection.field) {
    case "rotation": {
      return { ...config, rotation: selection.value };
    }
    case "skin": {
      return { ...config, skin: selection.value };
    }
    case "hairStyle": {
      return { ...config, hairStyle: selection.value };
    }
    case "hairColor": {
      return { ...config, hairColor: selection.value };
    }
    case "expression": {
      return { ...config, expression: selection.value };
    }
    case "intensity": {
      return { ...config, intensity: selection.value };
    }
  }
}

const internalOpen$ = state(false);
export const avatarMakerOpen$ = computed((get) => {
  return get(internalOpen$);
});

const internalConfig$ = state<ResolvedAvatarSvgConfig>(randomAvatarSvgConfig());
export const avatarMakerConfig$ = computed((get) => {
  return get(internalConfig$);
});

const internalStep$ = state<Step>("face");
export const avatarMakerStep$ = computed((get) => {
  return get(internalStep$);
});

/** True when the maker was opened on an avatar that already exists. */
const internalEditing$ = state(false);
export const avatarMakerEditing$ = computed((get) => {
  return get(internalEditing$);
});

export const avatarMakerSteps$ = computed((get) => {
  return stepsForConfig(get(internalConfig$), get(avatarNeckSweaterEnabled$));
});

export const avatarMakerStepIdx$ = computed((get) => {
  return get(avatarMakerSteps$).indexOf(get(internalStep$));
});

const internalJustPicked$ = state<string | null>(null);
export const avatarMakerJustPicked$ = computed((get) => {
  return get(internalJustPicked$);
});

const internalShowSparkles$ = state(false);
export const avatarMakerShowSparkles$ = computed((get) => {
  return get(internalShowSparkles$);
});

const internalShuffling$ = state(false);
export const avatarMakerShuffling$ = computed((get) => {
  return get(internalShuffling$);
});

const internalSaving$ = state(false);
export const avatarMakerSaving$ = computed((get) => {
  return get(internalSaving$);
});
export const setAvatarMakerSaving$ = command(({ set }, value: boolean) => {
  set(internalSaving$, value);
});

export const shuffleAvatar$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const config = get(internalConfig$);
    set(
      internalConfig$,
      isLegacyAvatarSvgConfig(config)
        ? randomLegacyAvatarSvgConfig()
        : randomAvatarSvgConfig(),
    );
    set(internalShuffling$, true);
    set(internalShowSparkles$, true);
    await delay(600, { signal });
    set(internalShuffling$, false);
    set(internalShowSparkles$, false);
  },
);

/**
 * Opens the maker on the avatar the caller currently shows. An avatar that can
 * be resolved is loaded as-is so it can be fine-tuned; only callers without one
 * start from a random config. The steps follow the loaded config, so a legacy
 * avatar keeps being edited in the legacy steps even once the composer ships.
 */
export const openAvatarMaker$ = command(
  ({ get, set }, avatarUrl: string | null) => {
    const composerEnabled =
      get(featureSwitch$)[FeatureSwitchKey.AvatarComposerV2];
    const current = resolveAvatarSvgConfig(avatarUrl);
    const config =
      current ??
      (composerEnabled
        ? randomAvatarSvgConfig()
        : randomLegacyAvatarSvgConfig());
    set(internalConfig$, config);
    set(
      internalStep$,
      stepsForConfig(config, get(avatarNeckSweaterEnabled$))[0]!,
    );
    set(internalEditing$, current !== null);
    set(internalJustPicked$, null);
    set(internalShowSparkles$, false);
    set(internalShuffling$, false);
    set(internalOpen$, true);
  },
);

export const selectAvatarOption$ = command(
  async (
    { get, set },
    selection: AvatarMakerSelection,
    signal: AbortSignal,
  ) => {
    const previous = get(internalConfig$);
    if (isLegacyAvatarSvgConfig(previous)) {
      if (selection.mode !== "legacy") {
        return;
      }
      set(internalConfig$, updateLegacyConfig(previous, selection));
    } else {
      if (selection.mode !== "composer") {
        return;
      }
      set(internalConfig$, updateAvatarComposerConfig(previous, selection));
    }

    set(internalJustPicked$, `${selection.field}-${selection.value}`);
    set(internalShowSparkles$, true);
    await delay(350, { signal });
    set(internalJustPicked$, null);
    set(internalShowSparkles$, false);

    const steps = stepsForConfig(previous, get(avatarNeckSweaterEnabled$));
    const idx = steps.indexOf(selection.field);
    if (idx + 1 < steps.length) {
      set(internalStep$, steps[idx + 1]!);
    }
  },
);

export const goBackStep$ = command(({ get, set }) => {
  const steps = get(avatarMakerSteps$);
  const idx = get(avatarMakerStepIdx$);
  if (idx > 0) {
    set(internalStep$, steps[idx - 1]!);
  }
});

export const goForwardStep$ = command(({ get, set }) => {
  const steps = get(avatarMakerSteps$);
  const idx = get(avatarMakerStepIdx$);
  if (idx + 1 < steps.length) {
    set(internalStep$, steps[idx + 1]!);
  }
});

export const closeAvatarMaker$ = command(({ set }) => {
  set(internalOpen$, false);
  set(internalShowSparkles$, false);
  set(internalJustPicked$, null);
});
