import { command, computed, state } from "ccstate";
import { logger } from "../log";
import { FeatureSwitchKey, getAllFeatureStates } from "@vm0/core";
import { localStorageSignals } from "./local-storage";
import { throwIfAbort } from "../utils";
import { clerk$, user$ } from "../auth";

const L = logger("FeatureSwitch");
const { get$, set$, clear$ } = localStorageSignals("featureSwitch");

const internalReload$ = state(0);

function applyOverrides(
  result: Record<FeatureSwitchKey, boolean>,
  overrides: Partial<Record<string, boolean>> | undefined,
  log?: boolean,
) {
  if (!overrides) {
    return;
  }
  for (const key of Object.values(FeatureSwitchKey)) {
    const value = overrides[key];
    if (value !== undefined) {
      result[key] = Boolean(value);
      if (log) {
        L.warn(`Override feature switch: ${key} = ${Boolean(value)}`);
      }
    }
  }
}

export const featureSwitch$ = computed(async (get) => {
  get(internalReload$);

  await Promise.resolve();

  const user = await get(user$);
  const userId = user?.id;
  const email = user?.primaryEmailAddress?.emailAddress;
  const clerk = await get(clerk$);
  const orgId = clerk.organization?.id;

  const result = getAllFeatureStates({ userId, email, orgId });

  // Layer 2: Clerk unsafeMetadata overrides (lower priority than localStorage)
  const unsafeMeta = user?.unsafeMetadata as
    | Record<string, unknown>
    | undefined;
  applyOverrides(
    result,
    unsafeMeta?.featureSwitches as Partial<Record<string, boolean>> | undefined,
  );

  // Layer 3: localStorage overrides (highest priority)
  const override = get(get$);
  if (override) {
    try {
      const parsed = JSON.parse(override) as
        | Partial<Record<string, boolean>>
        | undefined;
      applyOverrides(result, parsed, true);
    } catch (error) {
      throwIfAbort(error);
    }
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

export const syncFeatureSwitchToClerk$ = command(
  async (
    { get, set },
    overrides: Partial<Record<FeatureSwitchKey, boolean>>,
    signal: AbortSignal,
  ) => {
    const user = await get(user$);
    signal.throwIfAborted();
    if (!user) {
      return;
    }

    const existing = (user.unsafeMetadata ?? {}) as Record<string, unknown>;
    const currentSwitches = (existing.featureSwitches ?? {}) as Record<
      string,
      boolean
    >;
    const merged = { ...currentSwitches, ...overrides };

    await user.update({
      unsafeMetadata: { ...existing, featureSwitches: merged },
    });
    signal.throwIfAborted();
    set(internalReload$, (v) => {
      return v + 1;
    });
  },
);

export const resetFeatureSwitchOverrides$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Clear localStorage
    set(clear$);

    // Clear Clerk unsafeMetadata.featureSwitches
    const user = await get(user$);
    signal.throwIfAborted();
    if (user) {
      const existing = (user.unsafeMetadata ?? {}) as Record<string, unknown>;
      const { featureSwitches: _removed, ...rest } = existing;
      await user.update({ unsafeMetadata: rest });
    }

    set(internalReload$, (v) => {
      return v + 1;
    });
  },
);

export const setFeatureSwitchLocalStorage$ = set$;
