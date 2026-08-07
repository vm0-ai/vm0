import { command } from "ccstate";
import {
  isCodexFastModeModel,
  isSupportedRunModel,
  type OrgModelPoliciesResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import {
  modelAllowedForPlan,
  modelPlanCapabilities$,
  modelPolicyAllowedForPlan,
} from "./model-plan-capabilities.ts";

interface UserModelDefaultSource {
  selectedModel: string | null;
}

function createModelFirstSelection(
  selectedModel: string | null | undefined,
): ModelProviderSelection | null {
  if (!isSupportedRunModel(selectedModel)) {
    return null;
  }
  return {
    selectedModel,
  };
}

function resolveModelFirstWorkspaceDefaultSelection(
  policies: OrgModelPoliciesResponse | null | undefined,
): ModelProviderSelection | null {
  const defaultPolicy = policies?.policies.find((policy) => {
    return policy.isDefault && policy.routeStatus === "valid";
  });
  return createModelFirstSelection(
    defaultPolicy?.model ?? policies?.workspaceDefaultModel,
  );
}

export function isCodexFastModeAvailableForSelection(params: {
  readonly policies: OrgModelPoliciesResponse | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly codexFastModeEnabled: boolean;
}): boolean {
  if (
    !params.codexFastModeEnabled ||
    !isCodexFastModeModel(params.selectedModel)
  ) {
    return false;
  }
  const policy = params.policies?.policies.find((candidate) => {
    return candidate.model === params.selectedModel;
  });
  return (
    policy?.routeStatus === "valid" &&
    policy.defaultProviderType === "codex-oauth-token"
  );
}

export function applyCodexFastModeDefault(params: {
  readonly selection: ModelProviderSelection | null;
  readonly policies: OrgModelPoliciesResponse | null | undefined;
  readonly codexFastModeEnabled: boolean;
  readonly codexFastModeDefault: boolean;
}): ModelProviderSelection | null {
  if (
    !params.codexFastModeDefault ||
    !params.selection ||
    !isCodexFastModeAvailableForSelection({
      policies: params.policies,
      selectedModel: params.selection.selectedModel,
      codexFastModeEnabled: params.codexFastModeEnabled,
    })
  ) {
    return params.selection;
  }
  return { ...params.selection, codexServiceTier: "fast" };
}

export function resolveModelFirstUserDefaultSelection(params: {
  userPreference: UserModelDefaultSource | null | undefined;
  policies: OrgModelPoliciesResponse | null | undefined;
}): ModelProviderSelection | null {
  return (
    createModelFirstSelection(params.userPreference?.selectedModel) ??
    resolveModelFirstWorkspaceDefaultSelection(params.policies)
  );
}

type ExplicitModelSelectionResult =
  | { kind: "compare-plans" }
  | { kind: "select"; selection: ModelProviderSelection | null };

export const resolveExplicitModelSelection$ = command(
  async (
    { get },
    params: {
      selection: ModelProviderSelection | null;
      current: ModelProviderSelection | null;
      codexFastModeEnabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<ExplicitModelSelectionResult> => {
    const [policies, modelCapabilities] = await Promise.all([
      get(orgModelPolicies$),
      get(modelPlanCapabilities$),
    ]);
    signal.throwIfAborted();
    const selectedModel = params.selection?.selectedModel;
    const selectedPolicy = policies.policies.find((policy) => {
      return policy.model === selectedModel;
    });
    if (
      !modelAllowedForPlan(selectedModel, modelCapabilities) ||
      (selectedPolicy !== undefined &&
        !modelPolicyAllowedForPlan(selectedPolicy, modelCapabilities))
    ) {
      return { kind: "compare-plans" };
    }
    if (
      params.selection &&
      params.current?.codexServiceTier === "fast" &&
      isCodexFastModeAvailableForSelection({
        policies,
        selectedModel: params.selection.selectedModel,
        codexFastModeEnabled: params.codexFastModeEnabled,
      })
    ) {
      return {
        kind: "select",
        selection: { ...params.selection, codexServiceTier: "fast" },
      };
    }
    return { kind: "select", selection: params.selection };
  },
);
