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
  createOrgModelProvider$,
  deleteOrgModelProvider$,
  orgModelProviders$,
  setDefaultOrgModelProvider$,
} from "../../external/org-model-providers.ts";

// ---------------------------------------------------------------------------
// Add provider dialog (list of provider type cards)
// ---------------------------------------------------------------------------

const internalOrgAddProviderDialogOpen$ = state(false);
export const orgAddProviderDialogOpen$ = computed((get) => {
  return get(internalOrgAddProviderDialogOpen$);
});
export const setOrgAddProviderDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalOrgAddProviderDialogOpen$, open);
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

const internalOrgDialogState$ = state<DialogState>({
  open: false,
  mode: "add",
  providerType: null,
});

export const orgDialogState$ = computed((get) => {
  return get(internalOrgDialogState$);
});

// ---------------------------------------------------------------------------
// Delete dialog state
// ---------------------------------------------------------------------------

interface DeleteDialogState {
  open: boolean;
  providerType: ModelProviderType | null;
}

const internalOrgDeleteDialogState$ = state<DeleteDialogState>({
  open: false,
  providerType: null,
});

export const orgDeleteDialogState$ = computed((get) => {
  return get(internalOrgDeleteDialogState$);
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

const internalOrgFormValues$ = state<DialogFormValues>({
  secret: "",
  selectedModel: "",
  authMethod: "",
  secrets: {},
  useDefaultModel: true,
});

export const orgDialogFormValues$ = computed((get) => {
  return get(internalOrgFormValues$);
});

// ---------------------------------------------------------------------------
// Form validation errors
// ---------------------------------------------------------------------------

const internalOrgFormErrors$ = state<Record<string, string>>({});

export const orgFormErrors$ = computed((get) => {
  return get(internalOrgFormErrors$);
});

// ---------------------------------------------------------------------------
// Action promise (loading state)
// ---------------------------------------------------------------------------

const internalOrgActionPromise$ = state<Promise<unknown> | null>(null);

export const orgActionPromise$ = computed((get) => {
  return get(internalOrgActionPromise$);
});

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

export const orgConfiguredProviders$ = computed(async (get) => {
  const { modelProviders } = await get(orgModelProviders$);
  return [...modelProviders].sort((a, b) => {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
});

export const orgDefaultProvider$ = computed(async (get) => {
  const providers = await get(orgConfiguredProviders$);
  return (
    providers.find((p) => {
      return p.isDefault;
    }) ?? null
  );
});

// ---------------------------------------------------------------------------
// Commands: dialog open/close
// ---------------------------------------------------------------------------

export const orgOpenAddDialog$ = command(
  ({ set }, providerType: ModelProviderType) => {
    const defaultAuth = hasAuthMethods(providerType)
      ? (getDefaultAuthMethod(providerType) ?? "")
      : "";
    const defaultModel = hasModelSelection(providerType)
      ? (getDefaultModel(providerType) ?? "")
      : "";

    set(internalOrgFormValues$, {
      secret: "",
      selectedModel: defaultModel,
      authMethod: defaultAuth,
      secrets: {},
      useDefaultModel: !defaultModel,
    });
    set(internalOrgFormErrors$, {});
    set(internalOrgDialogState$, {
      open: true,
      mode: "add",
      providerType,
    });
  },
);

export const orgOpenEditDialog$ = command(
  ({ set }, provider: ModelProviderResponse) => {
    set(internalOrgFormValues$, {
      secret: "",
      selectedModel: provider.selectedModel ?? "",
      authMethod: provider.authMethod ?? "",
      secrets: {},
      useDefaultModel: !provider.selectedModel,
    });
    set(internalOrgFormErrors$, {});
    set(internalOrgDialogState$, {
      open: true,
      mode: "edit",
      providerType: provider.type,
    });
  },
);

export const orgCloseDialog$ = command(({ set }) => {
  set(internalOrgDialogState$, {
    open: false,
    mode: "add",
    providerType: null,
  });
  set(internalOrgFormValues$, {
    secret: "",
    selectedModel: "",
    authMethod: "",
    secrets: {},
    useDefaultModel: true,
  });
  set(internalOrgFormErrors$, {});
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const orgUpdateFormSecret$ = command(({ set }, value: string) => {
  set(internalOrgFormValues$, (prev) => {
    return { ...prev, secret: value };
  });
  set(internalOrgFormErrors$, (prev) => {
    const next = { ...prev };
    delete next["secret"];
    return next;
  });
});

export const orgUpdateFormModel$ = command(({ set }, value: string) => {
  set(internalOrgFormValues$, (prev) => {
    return {
      ...prev,
      selectedModel: value,
      useDefaultModel: false,
    };
  });
});

export const orgUpdateFormUseDefaultModel$ = command(
  ({ set }, value: boolean) => {
    set(internalOrgFormValues$, (prev) => {
      return {
        ...prev,
        useDefaultModel: value,
        selectedModel: value ? "" : prev.selectedModel,
      };
    });
  },
);

export const orgUpdateFormAuthMethod$ = command(({ set }, value: string) => {
  set(internalOrgFormValues$, (prev) => {
    return {
      ...prev,
      authMethod: value,
      secrets: {},
    };
  });
  set(internalOrgFormErrors$, {});
});

export const orgUpdateFormSecretField$ = command(
  ({ set }, key: string, value: string) => {
    set(internalOrgFormValues$, (prev) => {
      return {
        ...prev,
        secrets: { ...prev.secrets, [key]: value },
      };
    });
    set(internalOrgFormErrors$, (prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  },
);

// ---------------------------------------------------------------------------
// Commands: submit dialog
// ---------------------------------------------------------------------------

export const orgSubmitDialog$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const dialogState = get(internalOrgDialogState$);
    const formValues = get(internalOrgFormValues$);

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
      set(internalOrgFormErrors$, errors);
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
        createOrgModelProvider$,
        request as Parameters<typeof createOrgModelProvider$.write>[1],
        signal,
      );
      signal.throwIfAborted();

      const providerLabel =
        MODEL_PROVIDER_TYPES[providerType]?.label ?? providerType;
      toast.success(
        `${providerLabel} ${dialogState.mode === "add" ? "added" : "updated"} successfully`,
      );

      set(internalOrgDialogState$, {
        open: false,
        mode: "add",
        providerType: null,
      });
      set(internalOrgAddProviderDialogOpen$, false);
      set(internalOrgFormValues$, {
        secret: "",
        selectedModel: "",
        authMethod: "",
        secrets: {},
        useDefaultModel: true,
      });
      set(internalOrgFormErrors$, {});
    })();

    set(internalOrgActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalOrgActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Commands: delete
// ---------------------------------------------------------------------------

export const orgOpenDeleteDialog$ = command(
  ({ set }, providerType: ModelProviderType) => {
    set(internalOrgDeleteDialogState$, { open: true, providerType });
  },
);

export const orgCloseDeleteDialog$ = command(({ set }) => {
  set(internalOrgDeleteDialogState$, { open: false, providerType: null });
});

export const orgConfirmDelete$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const deleteState = get(internalOrgDeleteDialogState$);
    if (!deleteState.providerType) {
      return;
    }

    const providerType = deleteState.providerType;
    const providerLabel =
      MODEL_PROVIDER_TYPES[providerType]?.label ?? providerType;

    const promise = (async () => {
      await set(deleteOrgModelProvider$, providerType, signal);
      signal.throwIfAborted();
      toast.success(`${providerLabel} removed successfully`);
      set(internalOrgDeleteDialogState$, { open: false, providerType: null });
    })();

    set(internalOrgActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalOrgActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

// ---------------------------------------------------------------------------
// Commands: set default provider
// ---------------------------------------------------------------------------

export const orgSetDefaultProvider$ = command(
  async ({ set }, type: ModelProviderType, signal: AbortSignal) => {
    const providerLabel = MODEL_PROVIDER_TYPES[type]?.label ?? type;

    const promise = (async () => {
      await set(setDefaultOrgModelProvider$, type, signal);
      signal.throwIfAborted();
      toast.success(`${providerLabel} set as default`);
    })();

    set(internalOrgActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalOrgActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);
