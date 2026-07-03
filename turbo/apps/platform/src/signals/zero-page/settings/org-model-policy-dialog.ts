import { command, computed, state } from "ccstate";
import type {
  ModelProviderResponse,
  ModelProviderType,
  OrgModelPolicy,
  SupportedRunModel,
  UpdateOrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { createOrgModelProvider$ } from "../../external/org-model-providers.ts";
import {
  refreshOrgModelPolicies$,
  updateOrgModelPolicies$,
} from "../../external/org-model-policies.ts";

export type ModelPolicyDialogMode = "add" | "edit";
export type ModelPolicyRouteKind = "built-in" | "api-key" | "oauth";

interface ModelPolicyDialogState {
  open: boolean;
  mode: ModelPolicyDialogMode;
  model: SupportedRunModel | null;
  routeKind: ModelPolicyRouteKind;
  providerType: ModelProviderType | null;
}

const internalModelPolicyDialogState$ = state<ModelPolicyDialogState>({
  open: false,
  mode: "add",
  model: null,
  routeKind: "built-in",
  providerType: null,
});

const internalModelPolicyApiKey$ = state<string>("");
const internalModelPolicyApiKeyError$ = state<string | null>(null);
const internalModelPolicyApiKeyTouched$ = state<boolean>(false);

export const modelPolicyApiKey$ = computed((get) => {
  return get(internalModelPolicyApiKey$);
});

export const modelPolicyApiKeyError$ = computed((get) => {
  return get(internalModelPolicyApiKeyError$);
});

export const modelPolicyApiKeyTouched$ = computed((get) => {
  return get(internalModelPolicyApiKeyTouched$);
});

export const setModelPolicyApiKey$ = command(({ set }, value: string) => {
  set(internalModelPolicyApiKey$, value);
  set(internalModelPolicyApiKeyTouched$, true);
  set(internalModelPolicyApiKeyError$, null);
});

export const markModelPolicyApiKeyTouched$ = command(({ set }) => {
  set(internalModelPolicyApiKeyTouched$, true);
});

export const setModelPolicyApiKeyError$ = command(
  ({ set }, error: string | null) => {
    set(internalModelPolicyApiKeyError$, error);
  },
);

function isOAuthMemberType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function getPolicyRouteKind(policy: OrgModelPolicy): ModelPolicyRouteKind {
  if (policy.defaultProviderType === "vm0") {
    return "built-in";
  }
  if (isOAuthMemberType(policy.defaultProviderType)) {
    return "oauth";
  }
  return "api-key";
}

function toOrgModelPolicyUpdate(policy: OrgModelPolicy): UpdateOrgModelPolicy {
  return {
    model: policy.model,
    isDefault: policy.isDefault,
    defaultProviderType: policy.defaultProviderType,
    credentialScope: policy.credentialScope,
    modelProviderId: policy.modelProviderId,
  };
}

function applyProviderRouteToPolicies(
  policies: OrgModelPolicy[],
  model: SupportedRunModel,
  provider: ModelProviderResponse,
): UpdateOrgModelPolicy[] {
  let found = false;
  const updates = policies.map((policy) => {
    const update = toOrgModelPolicyUpdate(policy);
    if (policy.model !== model) {
      return update;
    }
    found = true;
    return {
      ...update,
      defaultProviderType: provider.type,
      credentialScope: "org" as const,
      modelProviderId: provider.id,
    };
  });

  if (!found) {
    updates.push({
      model,
      isDefault: updates.length === 0,
      defaultProviderType: provider.type,
      credentialScope: "org",
      modelProviderId: provider.id,
    });
  }

  return updates;
}

export const modelPolicyDialogState$ = computed((get) => {
  return get(internalModelPolicyDialogState$);
});

export const openAddModelPolicyDialog$ = command(
  ({ set }, model: SupportedRunModel | null) => {
    set(internalModelPolicyDialogState$, {
      open: true,
      mode: "add",
      model,
      routeKind: "built-in",
      providerType: null,
    });
    set(internalModelPolicyApiKey$, "");
    set(internalModelPolicyApiKeyTouched$, false);
    set(internalModelPolicyApiKeyError$, null);
  },
);

export const openEditModelPolicyDialog$ = command(
  ({ set }, policy: OrgModelPolicy) => {
    const routeKind = getPolicyRouteKind(policy);
    set(internalModelPolicyDialogState$, {
      open: true,
      mode: "edit",
      model: policy.model,
      routeKind,
      providerType:
        routeKind === "built-in" ? null : policy.defaultProviderType,
    });
    set(internalModelPolicyApiKey$, "");
    set(internalModelPolicyApiKeyTouched$, false);
    set(internalModelPolicyApiKeyError$, null);
  },
);

export const closeModelPolicyDialog$ = command(({ set }) => {
  set(internalModelPolicyDialogState$, {
    open: false,
    mode: "add",
    model: null,
    routeKind: "built-in",
    providerType: null,
  });
  set(internalModelPolicyApiKey$, "");
  set(internalModelPolicyApiKeyTouched$, false);
  set(internalModelPolicyApiKeyError$, null);
});

export const submitModelPolicyApiKeyRoute$ = command(
  async (
    { set },
    params: {
      model: SupportedRunModel;
      providerType: ModelProviderType;
      apiKey: string;
    },
    signal: AbortSignal,
  ) => {
    const result = await set(
      createOrgModelProvider$,
      { type: params.providerType, secret: params.apiKey },
      signal,
    );
    signal.throwIfAborted();

    const latest = await set(refreshOrgModelPolicies$, signal);
    signal.throwIfAborted();

    await set(
      updateOrgModelPolicies$,
      {
        policies: applyProviderRouteToPolicies(
          latest.policies,
          params.model,
          result.provider,
        ),
      },
      signal,
    );
    signal.throwIfAborted();
    set(closeModelPolicyDialog$);
  },
);

export const updateModelPolicyDialogModel$ = command(
  ({ set }, model: SupportedRunModel) => {
    set(internalModelPolicyDialogState$, (prev) => {
      return {
        ...prev,
        model,
        routeKind: "built-in" as const,
        providerType: null,
      };
    });
    set(internalModelPolicyApiKey$, "");
    set(internalModelPolicyApiKeyTouched$, false);
    set(internalModelPolicyApiKeyError$, null);
  },
);

export const updateModelPolicyDialogRoute$ = command(
  (
    { set },
    params: {
      routeKind: ModelPolicyRouteKind;
      providerType: ModelProviderType | null;
    },
  ) => {
    set(internalModelPolicyDialogState$, (prev) => {
      return { ...prev, ...params };
    });
    set(internalModelPolicyApiKey$, "");
    set(internalModelPolicyApiKeyTouched$, false);
    set(internalModelPolicyApiKeyError$, null);
  },
);
