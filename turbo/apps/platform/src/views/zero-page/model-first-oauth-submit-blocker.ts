import { useSet } from "ccstate-react";
import { setClaudeCodeDeviceAuthDialogStatePersonal$ } from "../../signals/zero-page/settings/claude-code-device-auth.ts";
import { setCodexDeviceAuthDialogStatePersonal$ } from "../../signals/zero-page/settings/codex-device-auth.ts";
import type {
  PersonalModelProviderStatusByModel,
  PersonalOauthProviderType,
} from "../../signals/zero-page/model-first-personal-oauth.ts";

type MemberOauthProviderType = PersonalOauthProviderType;
type CodexDeviceAuthDialogMode = "connect" | "reconnect";

interface ModelConfigurationSubmitBlocker {
  message: string;
  actionLabel: string;
  providerType: MemberOauthProviderType;
  codexDeviceAuthMode: CodexDeviceAuthDialogMode;
  onAction: () => void;
}

function getMemberOauthProviderLabel(type: MemberOauthProviderType): string {
  return type === "codex-oauth-token" ? "ChatGPT (Codex)" : "Claude Code OAuth";
}

function resolveModelConfigurationSubmitBlocker(
  status: PersonalModelProviderStatusByModel[string] | null | undefined,
): Omit<ModelConfigurationSubmitBlocker, "onAction"> | null {
  if (!status || status.status === "connected") {
    return null;
  }
  const label = getMemberOauthProviderLabel(status.providerType);
  return {
    providerType: status.providerType,
    codexDeviceAuthMode: status.status === "needs_reconnect"
      ? "reconnect"
      : "connect",
    message: status.status === "needs_reconnect"
      ? `${label} needs to be reconnected before you can use ${status.modelLabel}.`
      : `This workspace routes ${status.modelLabel} through your personal ${label}. Configure it before sending.`,
    actionLabel: "Model Configure",
  };
}

export function resolveChatComposerSubmitBlocker(params: {
  personalModelProvider: PersonalModelProviderStatusByModel | null | undefined;
  selectedModel: string;
  onAction: (
    providerType: MemberOauthProviderType,
    codexDeviceAuthMode: CodexDeviceAuthDialogMode,
  ) => void;
}): ModelConfigurationSubmitBlocker | undefined {
  const blocker = resolveModelConfigurationSubmitBlocker(
    params.personalModelProvider?.[params.selectedModel],
  );
  return blocker
    ? {
        ...blocker,
        onAction: () => {
          params.onAction(blocker.providerType, blocker.codexDeviceAuthMode);
        },
      }
    : undefined;
}

export function usePersonalOauthConfigurationAction() {
  const openClaudeCodeDeviceAuthDialog = useSet(
    setClaudeCodeDeviceAuthDialogStatePersonal$,
  );
  const openCodexDeviceAuthDialog = useSet(
    setCodexDeviceAuthDialogStatePersonal$,
  );
  return (
    providerType: MemberOauthProviderType,
    codexDeviceAuthMode: CodexDeviceAuthDialogMode,
  ) => {
    if (providerType === "claude-code-oauth-token") {
      openClaudeCodeDeviceAuthDialog({
        open: true,
        mode: codexDeviceAuthMode,
      });
      return;
    }
    if (providerType === "codex-oauth-token") {
      openCodexDeviceAuthDialog({ open: true, mode: codexDeviceAuthMode });
      return;
    }
  };
}
