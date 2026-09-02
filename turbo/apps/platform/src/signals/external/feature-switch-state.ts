import { computed } from "ccstate";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { localStorageSignals } from "./local-storage.ts";

export const FEATURE_SWITCH_CACHE_KEY = "vm0:feature-switch-cache:v4";

const { set$: setFeatureSwitchLocalStorage$, get$: featureSwitchCache$ } =
  localStorageSignals(FEATURE_SWITCH_CACHE_KEY);

export { setFeatureSwitchLocalStorage$ };

export const featureSwitchCacheState$ = computed((get) => {
  const raw = get(featureSwitchCache$);
  if (!raw) {
    // First-ever load: identity-gated switches start disabled until
    // `reloadFeatureSwitch$` populates the cache.
    return getAllFeatureStates({});
  }
  return JSON.parse(raw) as Record<FeatureSwitchKey, boolean>;
});
