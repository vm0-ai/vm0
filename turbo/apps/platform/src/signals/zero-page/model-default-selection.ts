import type { OrgModelPoliciesResponse } from "@vm0/api-contracts/contracts/model-providers";
import type { CodexServiceTier } from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";

interface UserModelDefaultSource {
  selectedModel: string | null;
  codexServiceTier?: CodexServiceTier | null;
}

export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

function createModelFirstSelection(
  selectedModel: string | null | undefined,
  codexServiceTier: CodexServiceTier | null | undefined = undefined,
): ModelProviderSelection | null {
  if (!selectedModel) {
    return null;
  }
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
    ...(codexServiceTier === "fast" ? { codexServiceTier } : {}),
  };
}

function codexFastModeAvailableForModel(
  policies: OrgModelPoliciesResponse | null | undefined,
  selectedModel: string | null | undefined,
): boolean {
  if (!selectedModel || selectedModel !== "gpt-5.5") {
    return false;
  }
  return (
    policies?.policies.some((policy) => {
      return (
        policy.model === selectedModel &&
        policy.routeStatus === "valid" &&
        policy.defaultProviderType === "codex-oauth-token"
      );
    }) ?? false
  );
}

function userDefaultCodexServiceTier(params: {
  userPreference: UserModelDefaultSource | null | undefined;
  policies: OrgModelPoliciesResponse | null | undefined;
  codexFastModeEnabled: boolean;
}): CodexServiceTier | undefined {
  return params.codexFastModeEnabled &&
    params.userPreference?.codexServiceTier === "fast" &&
    codexFastModeAvailableForModel(
      params.policies,
      params.userPreference.selectedModel,
    )
    ? "fast"
    : undefined;
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

export function resolveModelFirstUserDefaultSelection(params: {
  userPreference: UserModelDefaultSource | null | undefined;
  policies: OrgModelPoliciesResponse | null | undefined;
  codexFastModeEnabled?: boolean;
}): ModelProviderSelection | null {
  return (
    createModelFirstSelection(
      params.userPreference?.selectedModel,
      userDefaultCodexServiceTier({
        userPreference: params.userPreference,
        policies: params.policies,
        codexFastModeEnabled: params.codexFastModeEnabled ?? false,
      }),
    ) ?? resolveModelFirstWorkspaceDefaultSelection(params.policies)
  );
}
