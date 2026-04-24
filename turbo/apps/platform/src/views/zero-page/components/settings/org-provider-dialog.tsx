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
import { MODEL_PROVIDER_TYPES } from "@vm0/core/contracts/model-providers";
import { getProviderShape, getUILabel } from "./provider-ui-config.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  orgDialogState$,
  orgDialogFormValues$,
  orgFormErrors$,
  orgActionPromise$,
  orgCloseDialog$,
  orgUpdateFormSecret$,
  orgUpdateFormModel$,
  orgUpdateFormAuthMethod$,
  orgUpdateFormSecretField$,
  orgSubmitDialog$,
  orgUpdateFormUseDefaultModel$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";
import {
  OAuthFields,
  ApiKeyFields,
  MultiAuthFields,
  NoSecretFields,
} from "./provider-dialog-fields.tsx";

export function OrgProviderDialog() {
  const dialog = useGet(orgDialogState$);
  const formValues = useGet(orgDialogFormValues$);
  const errors = useGet(orgFormErrors$);
  const actionStatus = useLoadable(orgActionPromise$);
  const close = useSet(orgCloseDialog$);
  const setSecret = useSet(orgUpdateFormSecret$);
  const setModel = useSet(orgUpdateFormModel$);
  const setAuthMethod = useSet(orgUpdateFormAuthMethod$);
  const setSecretField = useSet(orgUpdateFormSecretField$);
  const submit = useSet(orgSubmitDialog$);
  const setUseDefaultModel = useSet(orgUpdateFormUseDefaultModel$);
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
              Workspace Model Provider
            </DialogTitle>
            <DialogDescription>
              Configure your workspace model provider settings.
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
    ? `${isEdit ? "Edit" : "Add"} ${label} provider (Workspace)`
    : isEdit
      ? `Edit workspace ${label}`
      : `Add workspace ${label}`;
  const descriptionText =
    isMultiAuth && providerHelpText
      ? providerHelpText.replace(/\n/g, " ")
      : isEdit
        ? `Update the workspace ${label}${subtitleSuffix}`
        : `Add a workspace-level ${label}${subtitleSuffix} for all members`;

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
