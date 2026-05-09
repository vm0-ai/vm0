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
  const subtitleSuffix =
    secretLabel && !label.toLowerCase().includes(secretLabel.toLowerCase())
      ? ` ${secretLabel.toLowerCase()}`
      : "";

  const handleSubmit = () => {
    detach(submit(pageSignal), Reason.DomCallback);
  };

  const isMultiAuth = shape === "multi-auth";
  const providerHelpText = "helpText" in config ? config.helpText : undefined;
  const titleText = isMultiAuth
    ? `${isEdit ? "Edit" : "Add"} ${label} provider (Personal)`
    : isEdit
      ? `Edit personal ${label}`
      : `Add personal ${label}`;
  const descriptionText =
    isMultiAuth && providerHelpText
      ? providerHelpText.replace(/\n/g, " ")
      : isEdit
        ? `Update your personal ${label}${subtitleSuffix}`
        : `Add a personal ${label}${subtitleSuffix} for your account`;

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
            {titleText}
          </DialogTitle>
          <DialogDescription className="break-words">
            {descriptionText}
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
            {isLoading ? "Saving..." : isEdit ? "Save changes" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
