import { computed } from "ccstate";
import { logger } from "../log";
import { FeatureSwitchKey, isFeatureEnabled } from "@vm0/core";
import { localStorageSignals } from "./local-storage";
import { throwIfAbort } from "../utils";

const L = logger("FeatureSwitch");
const { get$, set$ } = localStorageSignals("featureSwitch");

export const featureSwitch$ = computed(async (get) => {
  // force this computed be async because we may do async operations later
  await Promise.resolve();

  const result: Partial<Record<FeatureSwitchKey, boolean>> = {};
  for (const key of Object.values(FeatureSwitchKey)) {
    result[key] = Boolean(await isFeatureEnabled(key));
  }

  const override = get(get$);
  if (!override) {
    return result;
  }

  try {
    const parsed = JSON.parse(override);
    if (parsed) {
      L.debugGroup("Loaded feature switches from localStorage:");
      for (const key of Object.values(FeatureSwitchKey)) {
        const value = parsed[key];
        result[key] = Boolean(value);
      }
      L.debugGroupEnd();
    }
  } catch (error) {
    throwIfAbort(error);
  }

  return result;
});

export const setFeatureSwitchLocalStorage$ = set$;
