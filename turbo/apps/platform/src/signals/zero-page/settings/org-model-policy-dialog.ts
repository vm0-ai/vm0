import { command, computed, state } from "ccstate";
import type {
  ModelProviderType,
  OrgModelPolicy,
  SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";

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
