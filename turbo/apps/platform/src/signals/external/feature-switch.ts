import { command, computed, state } from "ccstate";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { clerk$, user$ } from "../auth";
import { accept } from "../../lib/accept.ts";
import { resolveApiBase } from "../api-base.ts";
import { createAuthedTsRestClient } from "../api-client-base.ts";

const internalReload$ = state(0);

// Transport only: feature switch data still flows through `featureSwitch$`.
// This client is pinned to the web backend so `apiBackend` can be derived
// without making feature switch loading depend on the backend it selects.
const webFeatureSwitchClient$ = computed((get) => {
  return createAuthedTsRestClient(zeroFeatureSwitchesContract, {
    baseUrl: resolveApiBase(false),
    getClerk: () => {
      return get(clerk$);
    },
  });
});

const dbFeatureSwitches$ = computed(async (get) => {
  get(internalReload$);
  const client = get(webFeatureSwitchClient$);
  const result = await accept(client.get(), [200], { toast: false });
  return result.body.switches;
});

function applySwitches(
  result: Record<FeatureSwitchKey, boolean>,
  overrides: Partial<Record<string, boolean>> | undefined,
) {
  if (!overrides) {
    return;
  }
  for (const key of Object.values(FeatureSwitchKey)) {
    const value = overrides[key];
    if (value !== undefined) {
      result[key] = Boolean(value);
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

  const dbSwitches = await get(dbFeatureSwitches$);
  applySwitches(result, dbSwitches);

  return result;
});

export const apiBackendEnabled$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  return features[FeatureSwitchKey.ApiBackend] ?? false;
});

export const setFeatureSwitch$ = command(
  async (
    { get, set },
    overrides: Partial<Record<FeatureSwitchKey, boolean>>,
    signal: AbortSignal,
  ) => {
    const client = get(webFeatureSwitchClient$);
    signal.throwIfAborted();
    await accept(
      client.update({
        body: { switches: overrides },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalReload$, (v) => {
      return v + 1;
    });
  },
);

export const resetFeatureSwitches$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(webFeatureSwitchClient$);
    signal.throwIfAborted();
    await accept(client.delete({ fetchOptions: { signal } }), [200]);
    signal.throwIfAborted();
    set(internalReload$, (v) => {
      return v + 1;
    });
  },
);

export const trinityEnabled$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  return features[FeatureSwitchKey.Trinity] ?? false;
});

export const detachedSetFeatureSwitch$ = command(
  (
    { set },
    overrides: Partial<Record<FeatureSwitchKey, boolean>>,
    signal: AbortSignal,
  ) => {
    // toast.error is already shown by accept() on API failure.
    // Swallow all rejections here so the fire-and-forget proxy setter does
    // not produce an unhandled promise rejection in the browser console.
    set(setFeatureSwitch$, overrides, signal).catch((_error: unknown) => {
      return;
    });
  },
);
