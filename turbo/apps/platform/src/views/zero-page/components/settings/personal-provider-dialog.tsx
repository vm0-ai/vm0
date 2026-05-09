// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { MODEL_PROVIDER_TYPES } from "@vm0/api-contracts/contracts/model-providers";
import { getProviderShape, getUILabel } from "./provider-ui-config.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  personalDialogState$,
  personalDialogHideModelSelector$,
  personalDialogFormValues$,
  personalFormErrors$,
  personalActionPromise$,
  personalCloseDialog$,
  personalUpdateFormSecret$,
  personalUpdateFormModel$,
  personalUpdateFormAuthMethod$,
  personalUpdateFormSecretField$,
  personalSubmitDialog$,
  personalUpdateFormUseDefaultModel$,
} from "../../../../signals/zero-page/settings/personal-model-providers.ts";
import {
  OAuthFields,
  ApiKeyFields,
  MultiAuthFields,
  NoSecretFields,
} from "./provider-dialog-fields.tsx";

export function PersonalProviderDialog() {
  const dialog = useGet(personalDialogState$);
  const hideModelSelector = useGet(personalDialogHideModelSelector$);
  const formValues = useGet(personalDialogFormValues$);
  const errors = useGet(personalFormErrors$);
  const actionStatus = useLoadable(personalActionPromise$);
  const close = useSet(personalCloseDialog$);
  const setSecret = useSet(personalUpdateFormSecret$);
  const setModel = useSet(personalUpdateFormModel$);
  const setAuthMethod = useSet(personalUpdateFormAuthMethod$);
  const setSecretField = useSet(personalUpdateFormSecretField$);
  const submit = useSet(personalSubmitDialog$);
  const setUseDefaultModel = useSet(personalUpdateFormUseDefaultModel$);
  const pageSignal = useGet(pageSignal$);

  if (!dialog.providerType) {
    return (
      <Dialog
        open={dialog.open}
        onOpenChange={() => {
          return close();
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-normal leading-7">
              Personal Model Provider
            </DialogTitle>
            <DialogDescription>
              Configure your personal model provider settings.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const providerType = dialog.providerType;
  const config = MODEL_PROVIDER_TYPES[providerType];
  const shape = getProviderShape(providerType);
  const isLoading = actionStatus.state === "loading";
  const isEdit = dialog.mode === "edit";
  const label = getUILabel(providerType);
  const secretLabel = "secretLabel" in config ? config.secretLabel : undefined;

  const handleSubmit = () => {
    detach(submit(pageSignal), Reason.DomCallback);
  };

  const isMultiAuth = shape === "multi-auth";
  const isOAuthConfiguration =
    providerType === "claude-code-oauth-token" && hideModelSelector;
  const providerHelpText = "helpText" in config ? config.helpText : undefined;
  const copy = getDialogCopy({
    isOAuthConfiguration,
    isMultiAuth,
    isEdit,
    label,
    secretLabel,
    providerHelpText,
  });

  return (
    <Dialog
      open={dialog.open}
      onOpenChange={() => {
        return close();
      }}
    >
      <DialogContent className={isMultiAuth ? "max-w-3xl" : "max-w-2xl"}>
        <DialogHeader>
          <DialogTitle className="font-normal leading-7">
            {copy.title}
          </DialogTitle>
          <DialogDescription className="break-words">
            {copy.description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {shape === "oauth" && (
            <OAuthFields
              secret={formValues.secret}
              selectedModel={formValues.selectedModel}
              useDefaultModel={formValues.useDefaultModel}
              hideModelSelector={hideModelSelector}
              onSecretChange={setSecret}
              onModelChange={setModel}
              onUseDefaultModelChange={setUseDefaultModel}
              error={errors["secret"]}
              isLoading={isLoading}
            />
          )}

          {shape === "api-key" && (
            <ApiKeyFields
              providerType={providerType}
              secret={formValues.secret}
              selectedModel={formValues.selectedModel}
              useDefaultModel={formValues.useDefaultModel}
              onSecretChange={setSecret}
              onModelChange={setModel}
              onUseDefaultModelChange={setUseDefaultModel}
              error={errors["secret"]}
              isEdit={isEdit}
              isLoading={isLoading}
            />
          )}

          {shape === "multi-auth" && (
            <MultiAuthFields
              providerType={providerType}
              authMethod={formValues.authMethod}
              secrets={formValues.secrets}
              selectedModel={formValues.selectedModel}
              useDefaultModel={formValues.useDefaultModel}
              onAuthMethodChange={setAuthMethod}
              onSecretFieldChange={setSecretField}
              onModelChange={setModel}
              onUseDefaultModelChange={setUseDefaultModel}
              errors={errors}
              isLoading={isLoading}
            />
          )}

          {shape === "no-secret" && (
            <NoSecretFields
              providerType={providerType}
              selectedModel={formValues.selectedModel}
              useDefaultModel={formValues.useDefaultModel}
              onModelChange={setModel}
              onUseDefaultModelChange={setUseDefaultModel}
            />
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              return close();
            }}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            {getSubmitLabel({ isLoading, isOAuthConfiguration, isEdit })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function getDialogCopy({
  isOAuthConfiguration,
  isMultiAuth,
  isEdit,
  label,
  secretLabel,
  providerHelpText,
}: {
  isOAuthConfiguration: boolean;
  isMultiAuth: boolean;
  isEdit: boolean;
  label: string;
  secretLabel: string | undefined;
  providerHelpText: string | undefined;
}): { title: string; description: string } {
  if (isOAuthConfiguration) {
    return {
      title: "Configure Claude Code OAuth",
      description:
        "Paste a Claude Code OAuth token for workspace model routes that use your Claude credentials.",
    };
  }

  if (isMultiAuth) {
    return {
      title: `${isEdit ? "Edit" : "Add"} ${label} provider (Personal)`,
      description: providerHelpText?.replace(/\n/g, " ") ?? "",
    };
  }

  const subtitleSuffix =
    secretLabel && !label.toLowerCase().includes(secretLabel.toLowerCase())
      ? ` ${secretLabel.toLowerCase()}`
      : "";
  return {
    title: isEdit ? `Edit personal ${label}` : `Add personal ${label}`,
    description: isEdit
      ? `Update your personal ${label}${subtitleSuffix}`
      : `Add a personal ${label}${subtitleSuffix} for your account`,
  };
}

function getSubmitLabel({
  isLoading,
  isOAuthConfiguration,
  isEdit,
}: {
  isLoading: boolean;
  isOAuthConfiguration: boolean;
  isEdit: boolean;
}): string {
  if (isLoading) {
    return "Saving...";
  }
  if (isOAuthConfiguration) {
    return "Save";
  }
  return isEdit ? "Save changes" : "Add";
}
