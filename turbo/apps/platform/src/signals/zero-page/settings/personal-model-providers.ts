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
  type OrgModelPolicy,
  type SupportedRunModel,
  type ModelProviderType,
  type UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  createPersonalModelProvider$,
  deletePersonalModelProvider$,
  personalModelProviders$,
  reloadPersonalModelProviders$,
} from "../../external/personal-model-providers.ts";
import { zeroPersonalModelProvidersMainContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";
import { zeroClient$ } from "../../api-client.ts";
import { accept } from "../../../lib/accept.ts";
import {
  orgModelPolicies$,
  updateOrgModelPolicies$,
} from "../../external/org-model-policies.ts";
import { apiBaseForNavigation$ } from "../../fetch.ts";
import { createDeferredPromise } from "../../utils.ts";

// ---------------------------------------------------------------------------
// Codex auth.json paste dialog (personal scope, mirrors org-side dialog from
// #11980; unified with org via #12024).
// ---------------------------------------------------------------------------

type CodexPasteDialogMode = "connect" | "reconnect";

interface CodexPasteDialogState {
  open: boolean;
  mode: CodexPasteDialogMode;
}

interface ModelPolicyRouteAfterPersonalAuth {
  providerType: ModelProviderType;
  model: SupportedRunModel;
}

const internalPersonalModelPolicyRouteAfterAuth$ =
  state<ModelPolicyRouteAfterPersonalAuth | null>(null);
const internalPersonalDialogHideModelSelector$ = state(false);

const internalCodexPasteDialogStatePersonal$ = state<CodexPasteDialogState>({
  open: false,
  mode: "connect",
});

const internalCodexPasteContentPersonal$ = state<string>("");

export const codexPasteDialogStatePersonal$ = computed((get) => {
  return get(internalCodexPasteDialogStatePersonal$);
});

export const codexPasteContentPersonal$ = computed((get) => {
  return get(internalCodexPasteContentPersonal$);
});

export const setCodexPasteDialogStatePersonal$ = command(
  ({ set }, next: CodexPasteDialogState) => {
    set(internalCodexPasteDialogStatePersonal$, next);
    if (!next.open) {
      set(internalCodexPasteContentPersonal$, "");
      set(internalPersonalModelPolicyRouteAfterAuth$, null);
    }
  },
);

function toOrgModelPolicyUpdate(policy: OrgModelPolicy): UpdateOrgModelPolicy {
  return {
    model: policy.model,
    isDefault: policy.isDefault,
    defaultProviderType: policy.defaultProviderType,
    credentialScope: policy.credentialScope,
    modelProviderId: policy.modelProviderId,
  };
}

function applyPersonalAuthRouteToPolicies(
  policies: OrgModelPolicy[],
  route: ModelPolicyRouteAfterPersonalAuth,
): UpdateOrgModelPolicy[] {
  let found = false;
  const updates = policies.map((policy) => {
    const update = toOrgModelPolicyUpdate(policy);
    if (policy.model !== route.model) {
      return update;
    }
    found = true;
    return {
      ...update,
      defaultProviderType: route.providerType,
      credentialScope: "member" as const,
      modelProviderId: null,
    };
  });

  if (!found) {
    updates.push({
      model: route.model,
      isDefault: updates.length === 0,
      defaultProviderType: route.providerType,
      credentialScope: "member",
      modelProviderId: null,
    });
  }

  return updates;
}

export const updateCodexPasteContentPersonal$ = command(
  ({ set }, paste: string) => {
    set(internalCodexPasteContentPersonal$, paste);
  },
);

/**
 * Submit the current personal codex paste content as `~/.codex/auth.json`
 * via the `auth_json` authMethod. Same semantics as the org-side
 * `submitCodexAuthJson$` — server parses, derives 4 CHATGPT_* secrets,
 * persists; toast suppressed so dialog renders typed errors inline.
 */
export const submitCodexAuthJsonPersonal$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const rawJson = get(internalCodexPasteContentPersonal$).trim();
    const createClient = get(zeroClient$);
    const client = createClient(zeroPersonalModelProvidersMainContract);
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

    const pendingRoute = get(internalPersonalModelPolicyRouteAfterAuth$);
    if (pendingRoute && pendingRoute.providerType === "codex-oauth-token") {
      const policyResponse = await get(orgModelPolicies$);
      signal.throwIfAborted();
      await set(
        updateOrgModelPolicies$,
        {
          policies: applyPersonalAuthRouteToPolicies(
            policyResponse.policies,
            pendingRoute,
          ),
          toast: false,
        },
        signal,
      );
      signal.throwIfAborted();
    }

    set(reloadPersonalModelProviders$);
    set(internalCodexPasteContentPersonal$, "");
    set(internalPersonalModelPolicyRouteAfterAuth$, null);
    set(internalCodexPasteDialogStatePersonal$, (prev) => {
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

const internalPersonalDialogState$ = state<DialogState>({
  open: false,
  mode: "add",
  providerType: null,
});

export const personalDialogState$ = computed((get) => {
  return get(internalPersonalDialogState$);
});

export const personalDialogHideModelSelector$ = computed((get) => {
  return (
    get(internalPersonalDialogHideModelSelector$) ||
    get(internalPersonalModelPolicyRouteAfterAuth$) !== null
  );
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

const CODEX_OAUTH_AUTHORIZE_PATH =
  "/api/zero/me/model-providers/codex-oauth-token/oauth/authorize";
const OAUTH_POPUP_CLOSED_POLL_MS = 500;

function waitForOAuthPopupClosed(
  authWindow: Window,
  signal: AbortSignal,
): Promise<void> {
  const closed = createDeferredPromise<void>(signal);
  const intervalId = window.setInterval(
    checkClosed,
    OAUTH_POPUP_CLOSED_POLL_MS,
  );

  function cleanup() {
    window.clearInterval(intervalId);
    signal.removeEventListener("abort", cleanup);
  }

  function checkClosed() {
    if (authWindow.closed && !closed.settled()) {
      cleanup();
      closed.resolve();
    }
  }

  signal.addEventListener("abort", cleanup, { once: true });
  checkClosed();

  return closed.promise;
}

function validatePersonalProviderForm(params: {
  providerType: ModelProviderType;
  formValues: DialogFormValues;
  mode: DialogState["mode"];
  requireSecret: boolean;
}): Record<string, string> {
  const { providerType, formValues, mode, requireSecret } = params;
  const errors: Record<string, string> = {};

  if (hasAuthMethods(providerType)) {
    const secretsConfig = getSecretsForAuthMethod(
      providerType,
      formValues.authMethod,
    );
    if (!secretsConfig) {
      return errors;
    }
    for (const [key, config] of Object.entries(secretsConfig)) {
      // Derived secrets are populated by a server-side parser, not the form.
      // Skip required-field validation for them (#12024).
      if (config.derived) {
        continue;
      }
      if (config.required && !formValues.secrets[key]?.trim()) {
        errors[key] = `${config.label} is required`;
      }
    }
    return errors;
  }

  if ((mode === "add" || requireSecret) && getSecretNameForType(providerType)) {
    if (!formValues.secret.trim()) {
      errors["secret"] =
        providerType === "claude-code-oauth-token"
          ? "OAuth token is required"
          : "API key is required";
    }
  }

  return errors;
}

function buildPersonalProviderRequest(
  providerType: ModelProviderType,
  formValues: DialogFormValues,
  skipModelSelection: boolean,
): Record<string, unknown> {
  const request: Record<string, unknown> = { type: providerType };

  if (hasAuthMethods(providerType)) {
    request.authMethod = formValues.authMethod;
    request.secrets = formValues.secrets;
  } else if (formValues.secret.trim()) {
    request.secret = formValues.secret;
  }

  if (
    !skipModelSelection &&
    hasModelSelection(providerType) &&
    !formValues.useDefaultModel &&
    formValues.selectedModel
  ) {
    request.selectedModel = formValues.selectedModel;
  }

  return request;
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

export const personalConfiguredProviders$ = computed(async (get) => {
  const { modelProviders } = await get(personalModelProviders$);
  return [...modelProviders].sort((a, b) => {
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
});

// ---------------------------------------------------------------------------
// Commands: dialog open/close
// ---------------------------------------------------------------------------

export const personalOpenOAuthCredentialDialog$ = command(
  ({ set }, providerType: ModelProviderType) => {
    set(internalPersonalModelPolicyRouteAfterAuth$, null);
    set(internalPersonalDialogHideModelSelector$, true);
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
      useDefaultModel: true,
    });
    set(internalPersonalFormErrors$, {});
    set(internalPersonalDialogState$, {
      open: true,
      mode: "add",
      providerType,
    });
  },
);

export const personalCloseDialog$ = command(({ set }) => {
  set(internalPersonalDialogState$, {
    open: false,
    mode: "add",
    providerType: null,
  });
  set(internalPersonalModelPolicyRouteAfterAuth$, null);
  set(internalPersonalDialogHideModelSelector$, false);
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
    const pendingRoute = get(internalPersonalModelPolicyRouteAfterAuth$);
    const pendingRouteMatchesProvider =
      pendingRoute?.providerType === providerType;

    const errors = validatePersonalProviderForm({
      providerType,
      formValues,
      mode: dialogState.mode,
      requireSecret: pendingRouteMatchesProvider,
    });

    if (Object.keys(errors).length > 0) {
      set(internalPersonalFormErrors$, errors);
      return;
    }

    const request = buildPersonalProviderRequest(
      providerType,
      formValues,
      pendingRouteMatchesProvider,
    );

    const promise = (async () => {
      await set(
        createPersonalModelProvider$,
        request as Parameters<typeof createPersonalModelProvider$.write>[1],
        signal,
      );
      signal.throwIfAborted();

      if (pendingRouteMatchesProvider && pendingRoute) {
        const policyResponse = await get(orgModelPolicies$);
        signal.throwIfAborted();
        await set(
          updateOrgModelPolicies$,
          {
            policies: applyPersonalAuthRouteToPolicies(
              policyResponse.policies,
              pendingRoute,
            ),
            toast: false,
          },
          signal,
        );
        signal.throwIfAborted();
      }

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
      set(internalPersonalModelPolicyRouteAfterAuth$, null);
      set(internalPersonalDialogHideModelSelector$, false);
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

export const disconnectPersonalOAuthCredential$ = command(
  async ({ set }, providerType: ModelProviderType, signal: AbortSignal) => {
    const providerLabel =
      MODEL_PROVIDER_TYPES[providerType]?.label ?? providerType;

    const promise = (async () => {
      await set(deletePersonalModelProvider$, providerType, signal);
      signal.throwIfAborted();
      toast.success(`${providerLabel} disconnected`);
    })();

    set(internalPersonalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalPersonalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

export const connectPersonalCodexOAuth$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const apiBase = await get(apiBaseForNavigation$);
    signal.throwIfAborted();

    const promise = (async () => {
      const authWindow = window.open(
        `${apiBase}${CODEX_OAUTH_AUTHORIZE_PATH}`,
        "_blank",
        "width=600,height=700",
      );
      if (!authWindow) {
        throw new Error("Failed to open OpenAI OAuth window");
      }

      await waitForOAuthPopupClosed(authWindow, signal);
      signal.throwIfAborted();
      set(reloadPersonalModelProviders$);
    })();

    set(internalPersonalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalPersonalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);
