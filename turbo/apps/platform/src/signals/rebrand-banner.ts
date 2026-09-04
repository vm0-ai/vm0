import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { brandName$ } from "./branding.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { localStorageSignals } from "./external/local-storage.ts";

const { get$: dismissedRaw$, set$: setDismissed$ } = localStorageSignals(
  "okou-rebrand-banner-dismissed",
);

export const rebrandBannerVisible$ = computed((get) => {
  // The announcement only makes sense where the product already reads as Okou.
  if (get(brandName$) !== "Okou") {
    return false;
  }
  if (get(dismissedRaw$) !== null) {
    return false;
  }
  return get(featureSwitch$)[FeatureSwitchKey.RebrandBanner] ?? false;
});

export const dismissRebrandBanner$ = command(({ set }) => {
  set(setDismissed$, "1");
});
