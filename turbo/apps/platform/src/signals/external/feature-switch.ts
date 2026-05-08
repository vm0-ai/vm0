import { command, computed } from "ccstate";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { clerk$ } from "../auth";
import { accept } from "../../lib/accept.ts";
import { resolveApiBase } from "../api-base.ts";
import { createAuthedTsRestClient } from "../api-client-base.ts";
import { localStorageSignals } from "./local-storage.ts";

export const FEATURE_SWITCH_CACHE_KEY = "vm0:feature-switch-cache:v1";

const { set$: setFeatureSwitchLocalStorage$, get$: featureSwitchCache$ } =
  localStorageSignals(FEATURE_SWITCH_CACHE_KEY);

// Pinned to the web backend: feature switches must load before
// `apiBackendEnabled$` is known, so the transport that fetches them cannot
// itself depend on it. Going through `zeroClient$` (which routes via
// `apiBase$` → `apiBackendEnabled$` → `featureSwitch$`) creates a static
// import cycle even though the runtime read is now sync from localStorage.
const webFeatureSwitchClient$ = computed((get) => {
  return createAuthedTsRestClient(zeroFeatureSwitchesContract, {
    baseUrl: resolveApiBase(false),
    getClerk: () => {
      return get(clerk$);
    },
  });
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

export const reloadFeatureSwitch$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    const user = clerk.user;
    if (!user) {
      return;
    }

    const client = get(webFeatureSwitchClient$);
    const result = await accept(
      client.get({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();

    const combined = getAllFeatureStates({
      userId: user.id,
      email: user.primaryEmailAddress?.emailAddress,
      orgId: clerk.organization?.id,
    });
    applySwitches(combined, result.body.switches);

    set(setFeatureSwitchLocalStorage$, JSON.stringify(combined));
  },
);

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
    await set(reloadFeatureSwitch$, signal);
  },
);

export const resetFeatureSwitches$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(webFeatureSwitchClient$);
    signal.throwIfAborted();
    await accept(client.delete({ fetchOptions: { signal } }), [200]);
    signal.throwIfAborted();
    await set(reloadFeatureSwitch$, signal);
  },
);

export const trinityEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.Trinity] ?? false;
});

export const pwaOfflineCacheEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.PwaOfflineCache] ?? false;
});

export const personalModelProviderEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.PersonalModelProvider] ?? false;
});

export const modelFirstModelProviderEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.ModelFirstModelProvider] ?? false;
});
