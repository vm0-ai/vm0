import type {
  ModelProviderResponse,
  ModelProviderType,
  OrgModelPoliciesResponse,
} from "@vm0/api-contracts/contracts/model-providers";
import { useSet } from "ccstate-react";
import {
  personalOpenOAuthCredentialDialog$,
  setCodexPasteDialogStatePersonal$,
} from "../../signals/zero-page/settings/personal-model-providers.ts";
import type { ModelFirstPersonalOauthState } from "../../signals/zero-page/model-first-personal-oauth.ts";
import type { ModelProviderSelection } from "./components/model-provider-picker.tsx";

type MemberOauthProviderType = "claude-code-oauth-token" | "codex-oauth-token";
type CodexPasteDialogMode = "connect" | "reconnect";

interface ModelConfigurationSubmitBlocker {
  message: string;
  actionLabel: string;
  providerType: MemberOauthProviderType;
  codexPasteMode: CodexPasteDialogMode;
  onAction: () => void;
}

function isMemberOauthProviderType(
  type: ModelProviderType,
): type is MemberOauthProviderType {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function getMemberOauthProviderLabel(type: MemberOauthProviderType): string {
  return type === "codex-oauth-token"
    ? "ChatGPT (Codex) auth.json"
    : "Claude Code OAuth";
}

function findPolicyForSelectedModel(
  policies: OrgModelPoliciesResponse,
  selectedModel: string | null,
) {
  const model = selectedModel ?? policies.workspaceDefaultModel;
  if (model) {
    const policy = policies.policies.find((item) => {
      return item.model === model;
    });
    if (policy) {
      return policy;
    }
  }
  return (
    policies.policies.find((item) => {
      return item.isDefault;
    }) ?? null
  );
}

function hasUsablePersonalProvider(
  providers: ModelProviderResponse[],
  providerType: MemberOauthProviderType,
): boolean {
  return providers.some((provider) => {
    return provider.type === providerType && !provider.needsReconnect;
  });
}

function resolveModelConfigurationSubmitBlocker(params: {
  state: ModelFirstPersonalOauthState | null;
  selectedModel: string | null;
}): Omit<ModelConfigurationSubmitBlocker, "onAction"> | null {
  if (!params.state) {
    return null;
  }
  const policy = findPolicyForSelectedModel(
    params.state.policies,
    params.selectedModel,
  );
  if (
    !policy ||
    policy.credentialScope !== "member" ||
    !isMemberOauthProviderType(policy.defaultProviderType)
  ) {
    return null;
  }
  const providerType = policy.defaultProviderType;
  if (hasUsablePersonalProvider(params.state.personalProviders, providerType)) {
    return null;
  }
  const label = getMemberOauthProviderLabel(providerType);
  const modelLabel = policy.modelLabel;
  const existingProvider = params.state.personalProviders.find((provider) => {
    return provider.type === providerType;
  });
  return {
    providerType,
    codexPasteMode: existingProvider?.needsReconnect ? "reconnect" : "connect",
    message: existingProvider?.needsReconnect
      ? `${label} needs to be reconnected before you can use ${modelLabel}.`
      : `This workspace routes ${modelLabel} through your personal ${label}. Configure it before sending.`,
    actionLabel: "Model Configure",
  };
}

export function resolveChatComposerSubmitBlocker(params: {
  state: ModelFirstPersonalOauthState | null | undefined;
  modelSelection: ModelProviderSelection | null;
  agentModelDefault: ModelProviderSelection | null;
  onAction: (
    providerType: MemberOauthProviderType,
    codexPasteMode: CodexPasteDialogMode,
  ) => void;
}): ModelConfigurationSubmitBlocker | undefined {
  const selectedModel =
    params.modelSelection?.selectedModel ??
    params.state?.userModelPreference.selectedModel ??
    params.state?.policies.workspaceDefaultModel ??
    null;
  const blocker = resolveModelConfigurationSubmitBlocker({
    state: params.state ?? null,
    selectedModel,
  });
  return blocker
    ? {
        ...blocker,
        onAction: () => {
          params.onAction(blocker.providerType, blocker.codexPasteMode);
        },
      }
    : undefined;
}

export function usePersonalOauthConfigurationAction() {
  const openCodexPasteDialog = useSet(setCodexPasteDialogStatePersonal$);
  const openCredentialDialog = useSet(personalOpenOAuthCredentialDialog$);
  return (
    providerType: MemberOauthProviderType,
    codexPasteMode: CodexPasteDialogMode,
  ) => {
    if (providerType === "codex-oauth-token") {
      openCodexPasteDialog({ open: true, mode: codexPasteMode });
      return;
    }
    openCredentialDialog(providerType);
  };
}
