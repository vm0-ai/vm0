import { command, computed, state } from "ccstate";
import {
  MODEL_PROVIDER_TYPES,
  getDefaultAuthMethod,
  getDefaultModel,
  getSecretsForAuthMethod,
  hasAuthMethods,
  hasModelSelection,
  type ModelProviderType,
  type ModelProviderResponse,
} from "@vm0/core";
import {
  createModelProvider$,
  deleteModelProvider$,
  modelProviders$,
  setDefaultModelProvider$,
} from "../external/model-providers.ts";

// ---------------------------------------------------------------------------
// Dialog state
// ---------------------------------------------------------------------------

interface DialogState {
  open: boolean;
  mode: "add" | "edit";
  providerType: ModelProviderType | null;
}

const internalDialogState$ = state<DialogState>({
  open: false,
  mode: "add",
  providerType: null,
});

export const dialogState$ = computed((get) => get(internalDialogState$));

// ---------------------------------------------------------------------------
// Delete dialog state
// ---------------------------------------------------------------------------

interface DeleteDialogState {
  open: boolean;
  providerType: ModelProviderType | null;
}

const internalDeleteDialogState$ = state<DeleteDialogState>({
  open: false,
  providerType: null,
});

export const deleteDialogState$ = computed((get) =>
  get(internalDeleteDialogState$),
);

// ---------------------------------------------------------------------------
// Form values
// ---------------------------------------------------------------------------

interface DialogFormValues {
  secret: string;
  selectedModel: string;
  authMethod: string;
  secrets: Record<string, string>;
  useDefaultModel: boolean;
}

const internalFormValues$ = state<DialogFormValues>({
  secret: "",
  selectedModel: "",
  authMethod: "",
  secrets: {},
  useDefaultModel: true,
});

export const dialogFormValues$ = computed((get) => get(internalFormValues$));

// ---------------------------------------------------------------------------
// Form validation errors
// ---------------------------------------------------------------------------

const internalFormErrors$ = state<Record<string, string>>({});

export const formErrors$ = computed((get) => get(internalFormErrors$));

// ---------------------------------------------------------------------------
// Action promise (loading state)
// ---------------------------------------------------------------------------

const internalActionPromise$ = state<Promise<unknown> | null>(null);

export const actionPromise$ = computed((get) => get(internalActionPromise$));

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

export const configuredProviders$ = computed(async (get) => {
  const { modelProviders } = await get(modelProviders$);
  // Sort by creation time (oldest first)
  return [...modelProviders].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
});

export const defaultProvider$ = computed(async (get) => {
  const providers = await get(configuredProviders$);
  return providers.find((p) => p.isDefault) ?? null;
});

export const availableProviderTypes$ = computed(async (get) => {
  const providers = await get(configuredProviders$);
  const configuredTypes = new Set(providers.map((p) => p.type));
  return (Object.keys(MODEL_PROVIDER_TYPES) as ModelProviderType[]).filter(
    (type) => !configuredTypes.has(type),
  );
});

// ---------------------------------------------------------------------------
// Commands: dialog open/close
// ---------------------------------------------------------------------------

export const openAddDialog$ = command(
  ({ set }, providerType: ModelProviderType) => {
    const defaultAuth = hasAuthMethods(providerType)
      ? (getDefaultAuthMethod(providerType) ?? "")
      : "";
    const defaultModel = hasModelSelection(providerType)
      ? (getDefaultModel(providerType) ?? "")
      : "";

    set(internalFormValues$, {
      secret: "",
      selectedModel: defaultModel,
      authMethod: defaultAuth,
      secrets: {},
      useDefaultModel: true,
    });
    set(internalFormErrors$, {});
    set(internalDialogState$, {
      open: true,
      mode: "add",
      providerType,
    });
  },
);

export const openEditDialog$ = command(
  ({ set }, provider: ModelProviderResponse) => {
    set(internalFormValues$, {
      secret: "",
      selectedModel: provider.selectedModel ?? "",
      authMethod: provider.authMethod ?? "",
      secrets: {},
      useDefaultModel: !provider.selectedModel,
    });
    set(internalFormErrors$, {});
    set(internalDialogState$, {
      open: true,
      mode: "edit",
      providerType: provider.type,
    });
  },
);

export const closeDialog$ = command(({ set }) => {
  set(internalDialogState$, { open: false, mode: "add", providerType: null });
  set(internalFormValues$, {
    secret: "",
    selectedModel: "",
    authMethod: "",
    secrets: {},
    useDefaultModel: true,
  });
  set(internalFormErrors$, {});
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const updateFormSecret$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({ ...prev, secret: value }));
  set(internalFormErrors$, (prev) => {
    const next = { ...prev };
    delete next["secret"];
    return next;
  });
});

export const updateFormModel$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({ ...prev, selectedModel: value }));
});

export const updateFormUseDefaultModel$ = command(({ set }, value: boolean) => {
  set(internalFormValues$, (prev) => ({
    ...prev,
    useDefaultModel: value,
    selectedModel: value ? "" : prev.selectedModel,
  }));
});

export const updateFormAuthMethod$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({
    ...prev,
    authMethod: value,
    secrets: {},
  }));
  set(internalFormErrors$, {});
});

export const updateFormSecretField$ = command(
  ({ set }, key: string, value: string) => {
    set(internalFormValues$, (prev) => ({
      ...prev,
      secrets: { ...prev.secrets, [key]: value },
    }));
    set(internalFormErrors$, (prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  },
);

// ---------------------------------------------------------------------------
// Commands: submit dialog
// ---------------------------------------------------------------------------

export const submitDialog$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const dialogState = get(internalDialogState$);
    const formValues = get(internalFormValues$);

    if (!dialogState.providerType) {
      return;
    }

    const providerType = dialogState.providerType;
    const isMultiAuth = hasAuthMethods(providerType);

    // Validate
    const errors: Record<string, string> = {};

    if (isMultiAuth) {
      // Multi-auth: validate secret fields
      const secretsConfig = getSecretsForAuthMethod(
        providerType,
        formValues.authMethod,
      );
      if (secretsConfig) {
        for (const [key, config] of Object.entries(secretsConfig)) {
          if (config.required && !formValues.secrets[key]?.trim()) {
            errors[key] = `${config.label} is required`;
          }
        }
      }
    } else if (dialogState.mode === "add") {
      // Single secret: required on add, optional on edit
      if (!formValues.secret.trim()) {
        errors["secret"] =
          providerType === "claude-code-oauth-token"
            ? "OAuth token is required"
            : "API key is required";
      }
    }

    if (Object.keys(errors).length > 0) {
      set(internalFormErrors$, errors);
      return;
    }

    // Build request
    const request: Record<string, unknown> = { type: providerType };

    if (isMultiAuth) {
      request.authMethod = formValues.authMethod;
      request.secrets = formValues.secrets;
    } else if (formValues.secret.trim()) {
      request.secret = formValues.secret;
    }

    if (
      hasModelSelection(providerType) &&
      !formValues.useDefaultModel &&
      formValues.selectedModel
    ) {
      request.selectedModel = formValues.selectedModel;
    }

    const promise = (async () => {
      await set(
        createModelProvider$,
        request as Parameters<typeof createModelProvider$.write>[1],
      );
      signal.throwIfAborted();
      set(internalDialogState$, {
        open: false,
        mode: "add",
        providerType: null,
      });
      set(internalFormValues$, {
        secret: "",
        selectedModel: "",
        authMethod: "",
        secrets: {},
        useDefaultModel: true,
      });
      set(internalFormErrors$, {});
    })();

    set(internalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Commands: delete
// ---------------------------------------------------------------------------

export const openDeleteDialog$ = command(
  ({ set }, providerType: ModelProviderType) => {
    set(internalDeleteDialogState$, { open: true, providerType });
  },
);

export const closeDeleteDialog$ = command(({ set }) => {
  set(internalDeleteDialogState$, { open: false, providerType: null });
});

export const confirmDelete$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const deleteState = get(internalDeleteDialogState$);
    if (!deleteState.providerType) {
      return;
    }

    const promise = (async () => {
      await set(deleteModelProvider$, deleteState.providerType as string);
      signal.throwIfAborted();
      set(internalDeleteDialogState$, { open: false, providerType: null });
    })();

    set(internalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Commands: set default provider
// ---------------------------------------------------------------------------

export const setDefaultProvider$ = command(
  async ({ set }, type: ModelProviderType, signal: AbortSignal) => {
    const promise = set(setDefaultModelProvider$, type);
    set(internalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);
