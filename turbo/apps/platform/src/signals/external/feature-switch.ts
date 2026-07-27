import { command, computed } from "ccstate";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { authenticatedIdentity$, clerk$ } from "../auth";
import { accept } from "../../lib/accept.ts";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { createAuthedContractClient } from "../api-client-base.ts";
import { unauthorizedRedirectSuppressionUntil$ } from "../auth-retry.ts";
import { localStorageSignals } from "./local-storage.ts";

export const FEATURE_SWITCH_CACHE_KEY = "vm0:feature-switch-cache:v3";

const { set$: setFeatureSwitchLocalStorage$, get$: featureSwitchCache$ } =
  localStorageSignals(FEATURE_SWITCH_CACHE_KEY);

// Pinned to the API backend: feature switches bootstrap before the platform API
// client is available.
const apiFeatureSwitchClient$ = computed((get) => {
  return createAuthedContractClient(zeroFeatureSwitchesContract, {
    baseUrl: resolveApiBaseForTarget("api"),
    getClerk: () => {
      return get(clerk$);
    },
    getUnauthorizedRedirectSuppressionUntil: () => {
      return get(unauthorizedRedirectSuppressionUntil$);
    },
  });
});

function applySwitches(
  result: Record<FeatureSwitchKey, boolean>,
  overrides: Partial<Record<string, boolean>> | undefined,
  effectiveSwitches: Partial<Record<string, boolean>> | undefined,
) {
  const resolvedSwitches = effectiveSwitches ?? overrides;
  if (resolvedSwitches) {
    for (const key of Object.values(FeatureSwitchKey)) {
      const value = resolvedSwitches[key];
      if (value !== undefined) {
        result[key] = Boolean(value);
      }
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

export const newChatThreadSidebarEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.NewChatThreadSidebar] ?? false;
});

export const codexFastModeEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.CodexFastMode] ?? false;
});

export const composerUploadPopoverEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ComposerUploadPopover] ?? false;
});

export const composerConnectorPermissionsEnabled$ = computed((get): boolean => {
  return (
    get(featureSwitch$)[FeatureSwitchKey.ComposerConnectorPermissions] ?? false
  );
});

const reloadFeatureSwitch$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();

    const client = get(apiFeatureSwitchClient$);
    const result = await accept(
      client.get({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();

    const combined = getAllFeatureStates({
      userId: identity.userId,
      email: identity.email,
      orgId: identity.orgId,
    });
    applySwitches(
      combined,
      result.body.switches,
      result.body.effectiveSwitches,
    );
    if (result.body.supportsStructuredFeedbackParts !== true) {
      // The capability field was added after the original structured-prompt
      // rollout. An older API cannot validate feedback parts, so keep the
      // whole structured-prompt path on its legacy payload until the API
      // handshake succeeds.
      combined[FeatureSwitchKey.StructuredPrompt] = false;
    }

    set(setFeatureSwitchLocalStorage$, JSON.stringify(combined));
  },
);

export const setFeatureSwitch$ = command(
  async (
    { get, set },
    overrides: Partial<Record<FeatureSwitchKey, boolean>>,
    signal: AbortSignal,
  ) => {
    const client = get(apiFeatureSwitchClient$);
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
    const client = get(apiFeatureSwitchClient$);
    signal.throwIfAborted();
    await accept(client.delete({ fetchOptions: { signal } }), [200]);
    signal.throwIfAborted();
    await set(reloadFeatureSwitch$, signal);
  },
);
