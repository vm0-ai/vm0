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
  },
);
