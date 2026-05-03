import { computed } from "ccstate";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { localStorageSignals } from "./local-storage.ts";

export const FEATURE_SWITCH_CACHE_KEY = "vm0:feature-switch-cache:v1";

const { set$: setFeatureSwitchLocalStorage$, get$: featureSwitchCache$ } =
  localStorageSignals(FEATURE_SWITCH_CACHE_KEY);

export { setFeatureSwitchLocalStorage$ };

export const featureSwitch$ = computed((get) => {
  const raw = get(featureSwitchCache$);
  if (!raw) {
    // First-ever load: identity-gated switches start disabled until
    // `reloadFeatureSwitch$` populates the cache.
    return getAllFeatureStates({});
  }
  return JSON.parse(raw) as Record<FeatureSwitchKey, boolean>;
});

export const apiBackendEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ApiBackend] ?? false;
});

export const trinityEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.Trinity] ?? false;
});

export const idbMessageEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.IdbMessage] ?? false;
});

export const pwaOfflineCacheEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.PwaOfflineCache] ?? false;
});
