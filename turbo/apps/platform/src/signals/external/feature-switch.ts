import { command, computed, state } from "ccstate";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { clerk$ } from "../auth";
import { accept } from "../../lib/accept.ts";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { createAuthedContractClient } from "../api-client-base.ts";
import { unauthorizedRedirectSuppressionUntil$ } from "../auth-retry.ts";
import { rootSignal$ } from "../root-signal.ts";
import { localStorageSignals } from "./local-storage.ts";

export const FEATURE_SWITCH_CACHE_KEY = "vm0:feature-switch-cache:v3";

const { set$: setFeatureSwitchLocalStorage$, get$: featureSwitchCache$ } =
  localStorageSignals(FEATURE_SWITCH_CACHE_KEY);
const imageRecognitionApiSupported$ = state(false);

// Pinned to the API backend: feature switches bootstrap before the platform API
// client is available.
const apiFeatureSwitchClient$ = computed((get) => {
  return createAuthedContractClient(zeroFeatureSwitchesContract, {
    baseUrl: resolveApiBaseForTarget("api"),
    getClerk: () => {
      return get(clerk$);
    },
    getRootSignal: () => {
      return get(rootSignal$);
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

export const zeroImageRecognitionEnabled$ = computed((get): boolean => {
  return (
    get(imageRecognitionApiSupported$) &&
    (get(featureSwitch$)[FeatureSwitchKey.ZeroImageRecognition] ?? false)
  );
});

export const artifactSidebarInlineOpenEnabled$ = computed((get): boolean => {
  return (
    get(featureSwitch$)[FeatureSwitchKey.ArtifactSidebarInlineOpen] ?? false
  );
});

export const chatThreadSidebarAutoOpenEnabled$ = computed((get): boolean => {
  return (
    get(featureSwitch$)[FeatureSwitchKey.ChatThreadSidebarAutoOpen] ?? false
  );
});

export const codexFastModeEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.CodexFastMode] ?? false;
});

export const composerUploadPopoverEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ComposerUploadPopover] ?? false;
});

export const pwaChatKeyboardGesturesEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.PwaChatKeyboardGestures] ?? false;
});

export const mermaidDiagramsEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.MermaidDiagrams] ?? false;
});

export const zeroBrowserEnabled$ = computed((get): boolean => {
  return get(featureSwitch$)[FeatureSwitchKey.ZeroBrowser] ?? false;
});

export const composerConnectorPermissionsEnabled$ = computed((get): boolean => {
  return (
    get(featureSwitch$)[FeatureSwitchKey.ComposerConnectorPermissions] ?? false
  );
});

export const reloadFeatureSwitch$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(imageRecognitionApiSupported$, false);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
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
    if (result.body.supportsStructuredInlineTemplates !== true) {
      combined[FeatureSwitchKey.StructuredPromptInlineTemplates] = false;
    }
    if (result.body.supportsCustomConnectorOAuth2 !== true) {
      combined[FeatureSwitchKey.CustomConnectorOAuth2] = false;
    }
    if (result.body.supportsCustomModelGateways !== true) {
      combined[FeatureSwitchKey.CustomModelGateways] = false;
    }
    const supportsImageRecognition =
      result.body.supportsImageRecognition === true;
    if (!supportsImageRecognition) {
      combined[FeatureSwitchKey.ZeroImageRecognition] = false;
    }

    set(setFeatureSwitchLocalStorage$, JSON.stringify(combined));
    set(imageRecognitionApiSupported$, supportsImageRecognition);
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
