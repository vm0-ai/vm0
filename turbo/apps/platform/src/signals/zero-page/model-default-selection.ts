import type { OrgModelPoliciesResponse } from "@vm0/api-contracts/contracts/model-providers";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";

interface UserModelDefaultSource {
  selectedModel: string | null;
}

export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

function createModelFirstSelection(
  selectedModel: string | null | undefined,
): ModelProviderSelection | null {
  if (!selectedModel) {
    return null;
  }
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
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
    !params.selectedModel ||
    params.selectedModel !== "gpt-5.5"
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
