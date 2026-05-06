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
import { zeroModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import {
  createOrgModelProvider$,
  deleteOrgModelProvider$,
  orgModelProviders$,
  reloadOrgModelProviders$,
  setDefaultOrgModelProvider$,
} from "../../external/org-model-providers.ts";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";

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
// Codex auth.json paste dialog (replaces broken cross-origin OAuth redirect;
// see #11980). Same dialog handles both first-time connect and re-paste
// recovery from a stale session — only the title differs by mode.
//
// Submit goes through `submitCodexAuthJson$` below. The dialog component
// drives that command via `useLoadableSet`, which gives it loading + error
// state for inline rendering. The command itself closes the dialog and
// resets the paste textarea on success — the bidirectional flow keeps the
// component free of try/catch (banned by no-restricted-syntax) and useState
// (banned by no-restricted-imports).
// ---------------------------------------------------------------------------

type CodexPasteDialogMode = "connect" | "reconnect";

interface CodexPasteDialogState {
  open: boolean;
  mode: CodexPasteDialogMode;
}

const internalCodexPasteDialogState$ = state<CodexPasteDialogState>({
  open: false,
  mode: "connect",
});

const internalCodexPasteContent$ = state<string>("");

export const codexPasteDialogState$ = computed((get) => {
  return get(internalCodexPasteDialogState$);
});

export const codexPasteContent$ = computed((get) => {
  return get(internalCodexPasteContent$);
});

export const setCodexPasteDialogState$ = command(
  ({ set }, next: CodexPasteDialogState) => {
    set(internalCodexPasteDialogState$, next);
    if (!next.open) {
      set(internalCodexPasteContent$, "");
    }
  },
);

export const updateCodexPasteContent$ = command(({ set }, paste: string) => {
  set(internalCodexPasteContent$, paste);
});

/**
 * Submit the current codex paste content as `~/.codex/auth.json` via the
 * `auth_json` authMethod. Server-side parser lives in #11978.
 *
 * Suppresses the default toast on error (`{ toast: false }`) so the paste
 * dialog can render typed error codes inline (e.g.
 * `CODEX_AUTH_JSON_SHAPE_INVALID`, `CODEX_FREE_PLAN_REJECTED`) —
 * `useLoadableSet` in the component reads these
 * codes off the rejected ApiError. On success, closes the dialog, resets
 * the paste textarea, and triggers an org-providers refetch so the stale
 * banner unmounts after a re-paste.
 */
export const submitCodexAuthJson$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const rawJson = get(internalCodexPasteContent$).trim();
    const createClient = get(zeroClient$);
    const client = createClient(zeroModelProvidersMainContract);
    const result = await accept(
      client.upsert({
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: rawJson },
        },
        fetchOptions: { signal },
      }),
      [200, 201],
      { toast: false },
    );
    signal.throwIfAborted();

    set(reloadOrgModelProviders$);
    set(internalCodexPasteContent$, "");
    set(internalCodexPasteDialogState$, (prev) => {
      return { ...prev, open: false };
    });

    return result.body;
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
