import { command, computed, state } from "ccstate";
import {
  getDefaultAuthMethod,
  getDefaultModel,
  getSecretsForAuthMethod,
  hasAuthMethods,
  hasModelSelection,
  type ModelProviderType,
} from "@vm0/core";
import { initScope$, hasScope$ } from "./scope.ts";
import {
  hasAnyModelProvider$,
  createModelProvider$,
} from "./external/model-providers.ts";
import { getProviderShape } from "../views/settings-page/provider-ui-config.ts";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalShowOnboardingModal$ = state(false);

const internalProviderType$ = state<ModelProviderType>(
  "claude-code-oauth-token",
);

interface OnboardingFormValues {
  secret: string;
  selectedModel: string;
  authMethod: string;
  secrets: Record<string, string>;
  useDefaultModel: boolean;
}

function defaultFormValues(): OnboardingFormValues {
  return {
    secret: "",
    selectedModel: "",
    authMethod: "",
    secrets: {},
    useDefaultModel: true,
  };
}

const internalFormValues$ = state<OnboardingFormValues>(defaultFormValues());

const internalCopyStatus$ = state<"idle" | "copied">("idle");

const internalCopyTimeoutId$ = state<number | null>(null);

const internalActionPromise$ = state<Promise<unknown> | null>(null);

// ---------------------------------------------------------------------------
// Exported computed state
// ---------------------------------------------------------------------------

export const showOnboardingModal$ = computed((get) =>
  get(internalShowOnboardingModal$),
);

export const onboardingProviderType$ = computed((get) =>
  get(internalProviderType$),
);

export const onboardingFormValues$ = computed((get) =>
  get(internalFormValues$),
);

export const copyStatus$ = computed((get) => get(internalCopyStatus$));

export const actionPromise$ = computed((get) => get(internalActionPromise$));

/**
 * Whether the Save button should be enabled.
 * Shape-aware validation matching the settings page dialog.
 */
export const canSaveOnboarding$ = computed((get) => {
  const providerType = get(internalProviderType$);
  const formValues = get(internalFormValues$);
  const shape = getProviderShape(providerType);

  if (shape === "multi-auth") {
    // For multi-auth, check required secret fields
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

  // For oauth and api-key shapes, require the secret field
  return formValues.secret.trim().length > 0;
});

/**
 * Whether the user needs to complete onboarding.
 * Returns true if scope is missing OR no model provider is configured.
 */
export const needsOnboarding$ = computed(async (get) => {
  const scopeExists = await get(hasScope$);
  const hasProvider = await get(hasAnyModelProvider$);
  return !scopeExists || !hasProvider;
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const setOnboardingProviderType$ = command(
  ({ set }, type: ModelProviderType) => {
    set(internalProviderType$, type);

    // Reset form values with defaults for the new provider type
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

export const setOnboardingSecret$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({ ...prev, secret: value }));
});

export const setOnboardingModel$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({ ...prev, selectedModel: value }));
});

export const setOnboardingUseDefaultModel$ = command(
  ({ set }, value: boolean) => {
    set(internalFormValues$, (prev) => ({
      ...prev,
      useDefaultModel: value,
      selectedModel: value ? "" : prev.selectedModel,
    }));
  },
);

export const setOnboardingAuthMethod$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({
    ...prev,
    authMethod: value,
    secrets: {},
  }));
});

export const setOnboardingSecretField$ = command(
  ({ set }, key: string, value: string) => {
    set(internalFormValues$, (prev) => ({
      ...prev,
      secrets: { ...prev.secrets, [key]: value },
    }));
  },
);

/**
 * Copy text to clipboard and show "copied" status for 5 seconds.
 */
export const copyToClipboard$ = command(({ get, set }, text: string) => {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const existingTimeoutId = get(internalCopyTimeoutId$);
      if (existingTimeoutId !== null) {
        window.clearTimeout(existingTimeoutId);
      }

      set(internalCopyStatus$, "copied");

      const timeoutId = window.setTimeout(() => {
        set(internalCopyStatus$, "idle");
        set(internalCopyTimeoutId$, null);
      }, 5000);
      set(internalCopyTimeoutId$, timeoutId);
    })
    .catch(() => {
      // Clipboard access may fail in some environments
    });
});

// ---------------------------------------------------------------------------
// Commands: lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the onboarding flow - show modal only.
 * Scope creation is deferred to save action.
 */
export const startOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalShowOnboardingModal$, true);

    // Create scope if it doesn't exist
    const scopeExists = await get(hasScope$);
    signal.throwIfAborted();

    if (!scopeExists) {
      await set(initScope$, signal);
      signal.throwIfAborted();
    }
  },
);

/**
 * Close the onboarding modal (Cancel / Add it later).
 */
export const closeOnboardingModal$ = command(({ set }) => {
  set(internalProviderType$, "claude-code-oauth-token");
  set(internalFormValues$, defaultFormValues());
  set(internalShowOnboardingModal$, false);
});

/**
 * Save the onboarding configuration.
 * Creates scope if needed and creates the model provider.
 */
export const saveOnboardingConfig$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const promise = (async () => {
      const providerType = get(internalProviderType$);
      const formValues = get(internalFormValues$);
      const shape = getProviderShape(providerType);

      // Validate based on shape
      if (shape === "multi-auth") {
        const secretsConfig = getSecretsForAuthMethod(
          providerType,
          formValues.authMethod,
        );
        if (secretsConfig) {
          for (const [key, config] of Object.entries(secretsConfig)) {
            if (config.required && !formValues.secrets[key]?.trim()) {
              return;
            }
          }
        }
      } else if (!formValues.secret.trim()) {
        return;
      }

      // Create scope if it doesn't exist
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

      // Reset and close
      set(internalProviderType$, "claude-code-oauth-token");
      set(internalFormValues$, defaultFormValues());
      set(internalShowOnboardingModal$, false);
    })();

    set(internalActionPromise$, promise);

    await promise;
    signal.throwIfAborted();
  },
);
