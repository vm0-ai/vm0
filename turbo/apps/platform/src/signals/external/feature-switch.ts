import { command, computed, state } from "ccstate";
import { logger } from "../log";
import { FeatureSwitchKey, getAllFeatureStates } from "@vm0/core";
import { localStorageSignals } from "./local-storage";
import { throwIfAbort } from "../utils";
import { clerk$, user$ } from "../auth";

const L = logger("FeatureSwitch");
const { get$, set$ } = localStorageSignals("featureSwitch");

const internalReload$ = state(0);

export const featureSwitch$ = computed(async (get) => {
  get(internalReload$);

  await Promise.resolve();

  const user = await get(user$);
  const userId = user?.id;
  const email = user?.primaryEmailAddress?.emailAddress;
  const clerk = await get(clerk$);
  const orgId = clerk.organization?.id;

  const result = getAllFeatureStates({ userId, email, orgId });

  const override = get(get$);
  if (!override) {
    return result;
  }

  try {
    const parsed = JSON.parse(override);
    if (parsed) {
      for (const key of Object.values(FeatureSwitchKey)) {
        const value = parsed[key];
        if (value !== undefined) {
          result[key] = Boolean(value);
          L.warn(`Override feature switch: ${key} = ${Boolean(value)}`);
        }
      }
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
    set(internalReload$, (v) => {
      return v + 1;
    });
  },
);

export const setFeatureSwitchLocalStorage$ = set$;
