import { command, computed, state } from "ccstate";
import { logger } from "../log";
import { FeatureSwitchKey, isFeatureEnabled } from "@vm0/core";
import { localStorageSignals } from "./local-storage";
import { throwIfAbort } from "../utils";

const L = logger("FeatureSwitch");
const { get$, set$ } = localStorageSignals("featureSwitch");

const internalReload$ = state(0);

export const featureSwitch$ = computed(async (get) => {
  get(internalReload$);

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

export const overrideFeatureSwitch$ = command(
  ({ get, set }, overrides: Partial<Record<FeatureSwitchKey, boolean>>) => {
    const current = get(get$);
    let parsed: Partial<Record<FeatureSwitchKey, boolean>> = {};
    if (current) {
      try {
        parsed = JSON.parse(current);
      } catch (error) {
        throwIfAbort(error);
      }
    }
    parsed = { ...parsed, ...overrides };
    set(set$, JSON.stringify(parsed));
    set(internalReload$, (v) => v + 1);
  },
);
L.debugGroup("Overriding feature switches:");

export const setFeatureSwitchLocalStorage$ = set$;
