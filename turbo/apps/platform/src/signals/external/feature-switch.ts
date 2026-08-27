import { command, computed } from "ccstate";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { authRecovery$, clerk$ } from "../auth";
import { accept } from "../../lib/accept.ts";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { createAuthedContractClient } from "../api-client-base.ts";
import { rootSignal$ } from "../root-signal.ts";
import { writeConnectionDiagnostic$ } from "../connection-diagnostics.ts";
import {
  featureSwitchCacheState$,
  setFeatureSwitchLocalStorage$,
} from "./feature-switch-state.ts";

// Pinned to the API backend: feature switches bootstrap before the platform API
// client is available.
const apiFeatureSwitchClient$ = computed((get) => {
  return createAuthedContractClient(featureSwitchesContract, {
    baseUrl: resolveApiBaseForTarget("api"),
    getAuthRecovery: () => {
      return get(authRecovery$);
    },
    getRootSignal: () => {
      return get(rootSignal$);
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
  return get(featureSwitchCacheState$);
});

export const imageRecognitionAvailable$ = computed((): boolean => {
  return true;
});

export const introVideoTemplatesEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.IntroVideoTemplates] ?? false;
});

export const composerImageAnnotationEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ComposerImageAnnotation] ?? false;
});

export const codexFastModeEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.CodexFastMode] ?? false;
});

export const customConnectorMcpEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.CustomConnectorMcp] ?? false;
});

export const reloadFeatureSwitch$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      set(writeConnectionDiagnostic$, {
        action: "set-enabled",
        enabled: false,
      });
      return;
    }

    const client = get(apiFeatureSwitchClient$);
    const result = await accept(
      client.get({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();

    const combined = getAllFeatureStates({
      userId: clerk.user.id,
      email: clerk.user.primaryEmailAddress?.emailAddress,
      orgId: clerk.organization.id,
    });
    applySwitches(
      combined,
      result.body.switches,
      result.body.effectiveSwitches,
    );
    set(setFeatureSwitchLocalStorage$, JSON.stringify(combined));
    set(writeConnectionDiagnostic$, {
      action: "set-enabled",
      enabled: combined[FeatureSwitchKey.OkouDebug],
    });
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
