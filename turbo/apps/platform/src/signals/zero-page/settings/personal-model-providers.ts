import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  MODEL_PROVIDER_TYPES,
  getDefaultAuthMethod,
  getDefaultModel,
  getSecretNameForType,
  getSecretsForAuthMethod,
  hasAuthMethods,
  hasModelSelection,
  type ModelProviderType,
  type ModelProviderResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  createPersonalModelProvider$,
  deletePersonalModelProvider$,
  personalModelProviders$,
  setDefaultPersonalModelProvider$,
} from "../../external/personal-model-providers.ts";

// ---------------------------------------------------------------------------
// Add provider dialog (list of provider type cards)
// ---------------------------------------------------------------------------

const internalPersonalAddProviderDialogOpen$ = state(false);
export const personalAddProviderDialogOpen$ = computed((get) => {
  return get(internalPersonalAddProviderDialogOpen$);
});
export const setPersonalAddProviderDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalPersonalAddProviderDialogOpen$, open);
  },
);

// ---------------------------------------------------------------------------
// Dialog state (add/edit single provider form)
// ---------------------------------------------------------------------------

interface DialogState {
  open: boolean;
  mode: "add" | "edit";
  providerType: ModelProviderType | null;
}

const internalPersonalDialogState$ = state<DialogState>({
  open: false,
  mode: "add",
  providerType: null,
});

export const personalDialogState$ = computed((get) => {
  return get(internalPersonalDialogState$);
});

// ---------------------------------------------------------------------------
// Delete dialog state
// ---------------------------------------------------------------------------

interface DeleteDialogState {
  open: boolean;
  providerType: ModelProviderType | null;
}

const internalPersonalDeleteDialogState$ = state<DeleteDialogState>({
  open: false,
  providerType: null,
});

export const personalDeleteDialogState$ = computed((get) => {
  return get(internalPersonalDeleteDialogState$);
});

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

const internalPersonalFormValues$ = state<DialogFormValues>({
  secret: "",
  selectedModel: "",
  authMethod: "",
  secrets: {},
  useDefaultModel: true,
});

export const personalDialogFormValues$ = computed((get) => {
  return get(internalPersonalFormValues$);
});

// ---------------------------------------------------------------------------
// Form validation errors
// ---------------------------------------------------------------------------

const internalPersonalFormErrors$ = state<Record<string, string>>({});

export const personalFormErrors$ = computed((get) => {
  return get(internalPersonalFormErrors$);
});

// ---------------------------------------------------------------------------
// Action promise (loading state)
// ---------------------------------------------------------------------------

const internalPersonalActionPromise$ = state<Promise<unknown> | null>(null);

export const personalActionPromise$ = computed((get) => {
  return get(internalPersonalActionPromise$);
});

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

export const personalConfiguredProviders$ = computed(async (get) => {
  const { modelProviders } = await get(personalModelProviders$);
  return [...modelProviders].sort((a, b) => {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
});

export const personalDefaultProvider$ = computed(async (get) => {
  const providers = await get(personalConfiguredProviders$);
  return (
    providers.find((p) => {
      return p.isDefault;
    }) ?? null
  );
});

// ---------------------------------------------------------------------------
// Commands: dialog open/close
// ---------------------------------------------------------------------------

export const personalOpenAddDialog$ = command(
  ({ set }, providerType: ModelProviderType) => {
    const defaultAuth = hasAuthMethods(providerType)
      ? (getDefaultAuthMethod(providerType) ?? "")
      : "";
    const defaultModel = hasModelSelection(providerType)
      ? (getDefaultModel(providerType) ?? "")
      : "";

    set(internalPersonalFormValues$, {
      secret: "",
      selectedModel: defaultModel,
      authMethod: defaultAuth,
      secrets: {},
      useDefaultModel: !defaultModel,
    });
    set(internalPersonalFormErrors$, {});
    set(internalPersonalDialogState$, {
      open: true,
      mode: "add",
      providerType,
    });
  },
);

export const personalOpenEditDialog$ = command(
  ({ set }, provider: ModelProviderResponse) => {
    set(internalPersonalFormValues$, {
      secret: "",
      selectedModel: provider.selectedModel ?? "",
      authMethod: provider.authMethod ?? "",
      secrets: {},
      useDefaultModel: !provider.selectedModel,
    });
    set(internalPersonalFormErrors$, {});
    set(internalPersonalDialogState$, {
      open: true,
      mode: "edit",
      providerType: provider.type,
    });
  },
);

export const personalCloseDialog$ = command(({ set }) => {
  set(internalPersonalDialogState$, {
    open: false,
    mode: "add",
    providerType: null,
  });
  set(internalPersonalFormValues$, {
    secret: "",
    selectedModel: "",
    authMethod: "",
    secrets: {},
    useDefaultModel: true,
  });
  set(internalPersonalFormErrors$, {});
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const personalUpdateFormSecret$ = command(({ set }, value: string) => {
  set(internalPersonalFormValues$, (prev) => {
    return { ...prev, secret: value };
  });
  set(internalPersonalFormErrors$, (prev) => {
    const next = { ...prev };
    delete next["secret"];
    return next;
  });
});

export const personalUpdateFormModel$ = command(({ set }, value: string) => {
  set(internalPersonalFormValues$, (prev) => {
    return {
      ...prev,
      selectedModel: value,
      useDefaultModel: false,
    };
  });
});

export const personalUpdateFormUseDefaultModel$ = command(
  ({ set }, value: boolean) => {
    set(internalPersonalFormValues$, (prev) => {
      return {
        ...prev,
        useDefaultModel: value,
        selectedModel: value ? "" : prev.selectedModel,
      };
    });
  },
);

export const personalUpdateFormAuthMethod$ = command(
  ({ set }, value: string) => {
    set(internalPersonalFormValues$, (prev) => {
      return {
        ...prev,
        authMethod: value,
        secrets: {},
      };
    });
    set(internalPersonalFormErrors$, {});
  },
);

export const personalUpdateFormSecretField$ = command(
  ({ set }, key: string, value: string) => {
    set(internalPersonalFormValues$, (prev) => {
      return {
        ...prev,
        secrets: { ...prev.secrets, [key]: value },
      };
    });
    set(internalPersonalFormErrors$, (prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  },
);

// ---------------------------------------------------------------------------
// Commands: submit dialog
// ---------------------------------------------------------------------------

export const personalSubmitDialog$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const dialogState = get(internalPersonalDialogState$);
    const formValues = get(internalPersonalFormValues$);

    if (!dialogState.providerType) {
      return;
    }

    const providerType = dialogState.providerType;
    const isMultiAuth = hasAuthMethods(providerType);

    // Validate
    const errors: Record<string, string> = {};

    if (isMultiAuth) {
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
    } else if (
      dialogState.mode === "add" &&
      getSecretNameForType(providerType)
    ) {
      if (!formValues.secret.trim()) {
        errors["secret"] =
          providerType === "claude-code-oauth-token"
            ? "OAuth token is required"
            : "API key is required";
      }
    }

    if (Object.keys(errors).length > 0) {
      set(internalPersonalFormErrors$, errors);
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
        createPersonalModelProvider$,
        request as Parameters<typeof createPersonalModelProvider$.write>[1],
        signal,
      );
      signal.throwIfAborted();

      const providerLabel =
        MODEL_PROVIDER_TYPES[providerType]?.label ?? providerType;
      toast.success(
        `${providerLabel} ${dialogState.mode === "add" ? "added" : "updated"} successfully`,
      );

      set(internalPersonalDialogState$, {
        open: false,
        mode: "add",
        providerType: null,
      });
      set(internalPersonalAddProviderDialogOpen$, false);
      set(internalPersonalFormValues$, {
        secret: "",
        selectedModel: "",
        authMethod: "",
        secrets: {},
        useDefaultModel: true,
      });
      set(internalPersonalFormErrors$, {});
    })();

    set(internalPersonalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalPersonalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Commands: delete
// ---------------------------------------------------------------------------

export const personalOpenDeleteDialog$ = command(
  ({ set }, providerType: ModelProviderType) => {
    set(internalPersonalDeleteDialogState$, { open: true, providerType });
  },
);

export const personalCloseDeleteDialog$ = command(({ set }) => {
  set(internalPersonalDeleteDialogState$, {
    open: false,
    providerType: null,
  });
});

export const personalConfirmDelete$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const deleteState = get(internalPersonalDeleteDialogState$);
    if (!deleteState.providerType) {
      return;
    }

    const providerType = deleteState.providerType;
    const providerLabel =
      MODEL_PROVIDER_TYPES[providerType]?.label ?? providerType;

    const promise = (async () => {
      await set(deletePersonalModelProvider$, providerType, signal);
      signal.throwIfAborted();
      toast.success(`${providerLabel} removed successfully`);
      set(internalPersonalDeleteDialogState$, {
        open: false,
        providerType: null,
      });
    })();

    set(internalPersonalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalPersonalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Commands: set default provider
// ---------------------------------------------------------------------------

export const personalSetDefaultProvider$ = command(
  async ({ set }, type: ModelProviderType, signal: AbortSignal) => {
    const providerLabel = MODEL_PROVIDER_TYPES[type]?.label ?? type;

    const promise = (async () => {
      await set(setDefaultPersonalModelProvider$, type, signal);
      signal.throwIfAborted();
      toast.success(`${providerLabel} set as your personal default`);
    })();

    set(internalPersonalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalPersonalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);
