import { command, computed, state } from "ccstate";
import {
  type ModelProviderType,
  getDefaultAuthMethod,
  getDefaultModel,
  getSecretsForAuthMethod,
  hasAuthMethods,
  hasModelSelection,
  onboardingStatusResponseSchema,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { initScope$, hasScope$ } from "../scope.ts";
import { createModelProvider$ } from "../external/model-providers.ts";
import { getProviderShape } from "../../views/settings-page/provider-ui-config.ts";
import { logger } from "../log.ts";

const L = logger("ZeroOnboarding");

// ---------------------------------------------------------------------------
// Onboarding status (from API)
// ---------------------------------------------------------------------------

const internalReload$ = state(0);

export const zeroOnboardingStatus$ = computed(async (get) => {
  get(internalReload$);
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/onboarding/status");
  if (!resp.ok) {
    throw new Error(`Failed to fetch onboarding status: ${resp.status}`);
  }
  return onboardingStatusResponseSchema.parse(await resp.json());
});

export const zeroNeedsOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.needsOnboarding;
});

export const zeroHasModelProvider$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.hasModelProvider;
});

// ---------------------------------------------------------------------------
// Onboarding form state
// ---------------------------------------------------------------------------

type ZeroOnboardingStep = "1" | "2" | "3" | "4" | "done";

const internalStep$ = state<ZeroOnboardingStep>("1");
const internalAgentName$ = state("zero");
const internalProviderType$ = state<ModelProviderType>(
  "claude-code-oauth-token",
);

interface ZeroFormValues {
  secret: string;
  selectedModel: string;
  authMethod: string;
  secrets: Record<string, string>;
  useDefaultModel: boolean;
}

function defaultFormValues(): ZeroFormValues {
  return {
    secret: "",
    selectedModel: "",
    authMethod: "",
    secrets: {},
    useDefaultModel: true,
  };
}

const internalFormValues$ = state<ZeroFormValues>(defaultFormValues());
const internalSaving$ = state(false);

// ---------------------------------------------------------------------------
// Exported computed state
// ---------------------------------------------------------------------------

export const zeroOnboardingStep$ = computed((get) => get(internalStep$));
export const zeroAgentName$ = computed((get) => get(internalAgentName$));
export const zeroProviderType$ = computed((get) => get(internalProviderType$));
export const zeroFormValues$ = computed((get) => get(internalFormValues$));
export const zeroSaving$ = computed((get) => get(internalSaving$));

export const zeroCanSave$ = computed((get) => {
  const providerType = get(internalProviderType$);
  const formValues = get(internalFormValues$);
  const shape = getProviderShape(providerType);

  if (shape === "multi-auth") {
    const secretsConfig = getSecretsForAuthMethod(
      providerType,
      formValues.authMethod,
    );
    if (!secretsConfig) {
      return false;
    }
    for (const [key, config] of Object.entries(secretsConfig)) {
      if (config.required && !formValues.secrets[key]?.trim()) {
        return false;
      }
    }
    return true;
  }

  return formValues.secret.trim().length > 0;
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const setZeroStep$ = command(({ set }, step: ZeroOnboardingStep) => {
  set(internalStep$, step);
});

export const setZeroAgentName$ = command(({ set }, name: string) => {
  set(internalAgentName$, name);
});

export const setZeroProviderType$ = command(
  ({ set }, type: ModelProviderType) => {
    set(internalProviderType$, type);

    const defaultAuth = hasAuthMethods(type)
      ? (getDefaultAuthMethod(type) ?? "")
      : "";
    const defaultModel = hasModelSelection(type)
      ? (getDefaultModel(type) ?? "")
      : "";

    set(internalFormValues$, {
      secret: "",
      selectedModel: defaultModel,
      authMethod: defaultAuth,
      secrets: {},
      useDefaultModel: true,
    });
  },
);

export const setZeroSecret$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({ ...prev, secret: value }));
});

export const setZeroModel$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({
    ...prev,
    selectedModel: value,
    useDefaultModel: false,
  }));
});

export const setZeroUseDefaultModel$ = command(({ set }, value: boolean) => {
  set(internalFormValues$, (prev) => ({
    ...prev,
    useDefaultModel: value,
    selectedModel: value ? "" : prev.selectedModel,
  }));
});

export const setZeroAuthMethod$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({
    ...prev,
    authMethod: value,
    secrets: {},
  }));
});

export const setZeroSecretField$ = command(
  ({ set }, key: string, value: string) => {
    set(internalFormValues$, (prev) => ({
      ...prev,
      secrets: { ...prev.secrets, [key]: value },
    }));
  },
);

// ---------------------------------------------------------------------------
// Commands: lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize onboarding step based on current status.
 * Skips steps that are already completed.
 */
export const initZeroOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const status = await get(zeroOnboardingStatus$);
    signal.throwIfAborted();

    if (!status.needsOnboarding) {
      set(internalStep$, "done");
      return;
    }

    // Always start from step 1 when onboarding is needed
    set(internalStep$, "1");
  },
);

/**
 * Save model provider (step 2 completion).
 * Creates scope if needed, then creates model provider.
 */
export const saveZeroModelProvider$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalSaving$, true);

    try {
      const providerType = get(internalProviderType$);
      const formValues = get(internalFormValues$);
      const shape = getProviderShape(providerType);

      // Create scope if needed
      const scopeExists = await get(hasScope$);
      signal.throwIfAborted();

      if (!scopeExists) {
        await set(initScope$, signal);
        signal.throwIfAborted();
      }

      // Build request based on provider shape
      const request: Record<string, unknown> = { type: providerType };

      if (shape === "multi-auth") {
        request.authMethod = formValues.authMethod;
        request.secrets = formValues.secrets;
      } else {
        request.secret = formValues.secret.trim();
      }

      if (
        hasModelSelection(providerType) &&
        !formValues.useDefaultModel &&
        formValues.selectedModel
      ) {
        request.selectedModel = formValues.selectedModel;
      }

      await set(
        createModelProvider$,
        request as Parameters<typeof createModelProvider$.write>[1],
      );
      signal.throwIfAborted();

      L.debug("Model provider created during zero onboarding");
    } finally {
      set(internalSaving$, false);
    }
  },
);

/**
 * Complete onboarding: create agent compose and set as default.
 */
export const completeZeroOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalSaving$, true);

    try {
      const agentName = get(internalAgentName$);
      const fetchFn = get(fetch$);

      // Create agent compose
      const composeResp = await fetchFn("/api/agent/composes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: {
            version: "1",
            agents: {
              [agentName]: {
                framework: "claude-code",
              },
            },
          },
        }),
      });
      signal.throwIfAborted();

      if (!composeResp.ok) {
        throw new Error(
          `Failed to create agent compose: ${composeResp.status}`,
        );
      }

      const composeData = (await composeResp.json()) as {
        composeId: string;
        name: string;
      };
      signal.throwIfAborted();

      // Set as default agent
      const defaultResp = await fetchFn("/api/scopes/default-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: composeData.composeId,
        }),
      });
      signal.throwIfAborted();

      if (!defaultResp.ok) {
        throw new Error(`Failed to set default agent: ${defaultResp.status}`);
      }

      L.debug("Zero onboarding completed", {
        agentName: composeData.name,
        composeId: composeData.composeId,
      });

      // Reload status and mark done
      set(internalReload$, (x) => x + 1);
      set(internalStep$, "done");
    } finally {
      set(internalSaving$, false);
    }
  },
);
