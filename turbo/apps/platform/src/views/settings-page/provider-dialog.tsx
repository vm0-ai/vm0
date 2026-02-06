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
import { Input } from "@vm0/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import {
  MODEL_PROVIDER_TYPES,
  getAuthMethodsForType,
  getSecretsForAuthMethod,
  getModels,
  getDefaultModel,
  hasModelSelection,
  allowsCustomModel,
  getCustomModelPlaceholder,
} from "@vm0/core";
import {
  getProviderShape,
  getUILabel,
  getUIDefaultModel,
  getUISecretField,
  getUIAuthMethodLabel,
} from "./provider-ui-config.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  dialogState$,
  dialogFormValues$,
  formErrors$,
  actionPromise$,
  closeDialog$,
  updateFormSecret$,
  updateFormModel$,
  updateFormAuthMethod$,
  updateFormSecretField$,
  submitDialog$,
  updateFormUseDefaultModel$,
} from "../../signals/settings-page/model-providers.ts";
import { ClaudeCodeSetupPrompt } from "./setup-prompt.tsx";

export function ProviderDialog() {
  const dialog = useGet(dialogState$);
  const formValues = useGet(dialogFormValues$);
  const errors = useGet(formErrors$);
  const actionStatus = useLoadable(actionPromise$);
  const close = useSet(closeDialog$);
  const setSecret = useSet(updateFormSecret$);
  const setModel = useSet(updateFormModel$);
  const setAuthMethod = useSet(updateFormAuthMethod$);
  const setSecretField = useSet(updateFormSecretField$);
  const submit = useSet(submitDialog$);
  const setUseDefaultModel = useSet(updateFormUseDefaultModel$);
  const pageSignal = useGet(pageSignal$);

  if (!dialog.providerType) {
    return (
      <Dialog open={dialog.open} onOpenChange={() => close()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-normal leading-7">
              Model Provider
            </DialogTitle>
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
    ? `${isEdit ? "Edit" : "Add"} ${label} provider configuration`
    : isEdit
      ? `Edit your ${label}`
      : `Add your ${label}`;
  const descriptionText =
    isMultiAuth && providerHelpText
      ? providerHelpText.replace(/\n/g, " ")
      : isEdit
        ? `Update your ${label}${subtitleSuffix}`
        : `Add your ${label}${subtitleSuffix} to start using the integration`;

  return (
    <Dialog open={dialog.open} onOpenChange={() => close()}>
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
              onSecretChange={setSecret}
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
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => close()}
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

function OAuthFields({
  secret,
  onSecretChange,
  error,
  isLoading,
}: {
  secret: string;
  onSecretChange: (value: string) => void;
  error?: string;
  isLoading: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <label className="text-sm font-medium text-foreground">
        Claude code OAuth token
      </label>
      <Input
        value={secret}
        placeholder="sk-ant-XXXXXXX"
        onChange={(e) => onSecretChange(e.target.value)}
        readOnly={isLoading}
        className={error ? "border-destructive" : ""}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <ClaudeCodeSetupPrompt />
    </div>
  );
}

function ApiKeyFields({
  providerType,
  secret,
  selectedModel,
  useDefaultModel,
  onSecretChange,
  onModelChange,
  onUseDefaultModelChange,
  error,
  isEdit,
  isLoading,
}: {
  providerType: string;
  secret: string;
  selectedModel: string;
  useDefaultModel: boolean;
  onSecretChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onUseDefaultModelChange: (value: boolean) => void;
  error?: string;
  isEdit: boolean;
  isLoading: boolean;
}) {
  const config =
    MODEL_PROVIDER_TYPES[providerType as keyof typeof MODEL_PROVIDER_TYPES];
  const fieldSecretLabel =
    "secretLabel" in config ? config.secretLabel : "API key";
  const helpText = "helpText" in config ? config.helpText : undefined;

  return (
    <>
      <div className="flex flex-col gap-3">
        <label className="text-sm font-medium text-foreground">
          {fieldSecretLabel}
        </label>
        <Input
          value={secret}
          placeholder={
            isEdit
              ? `Enter new ${fieldSecretLabel} to update`
              : `Enter your ${fieldSecretLabel}`
          }
          onChange={(e) => onSecretChange(e.target.value)}
          readOnly={isLoading}
          className={error ? "border-destructive" : ""}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        {helpText && (
          <p className="text-xs text-muted-foreground">{helpText}</p>
        )}
      </div>
      <ModelSelector
        providerType={providerType}
        selectedModel={selectedModel}
        useDefaultModel={useDefaultModel}
        onModelChange={onModelChange}
        onUseDefaultModelChange={onUseDefaultModelChange}
      />
    </>
  );
}

function MultiAuthFields({
  providerType,
  authMethod,
  secrets,
  selectedModel,
  useDefaultModel,
  onAuthMethodChange,
  onSecretFieldChange,
  onModelChange,
  onUseDefaultModelChange,
  errors,
  isLoading,
}: {
  providerType: string;
  authMethod: string;
  secrets: Record<string, string>;
  selectedModel: string;
  useDefaultModel: boolean;
  onAuthMethodChange: (value: string) => void;
  onSecretFieldChange: (key: string, value: string) => void;
  onModelChange: (value: string) => void;
  onUseDefaultModelChange: (value: boolean) => void;
  errors: Record<string, string>;
  isLoading: boolean;
}) {
  const type = providerType as keyof typeof MODEL_PROVIDER_TYPES;
  const authMethods = getAuthMethodsForType(type);

  if (!authMethods) {
    return null;
  }

  const authMethodEntries = Object.entries(authMethods);
  const currentSecrets = authMethod
    ? getSecretsForAuthMethod(type, authMethod)
    : undefined;

  return (
    <>
      {authMethodEntries.length > 1 && (
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium text-foreground">
            Select authentication method
          </label>
          <Select value={authMethod} onValueChange={onAuthMethodChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select auth method" />
            </SelectTrigger>
            <SelectContent>
              {authMethodEntries.map(([key, method]) => (
                <SelectItem key={key} value={key}>
                  {getUIAuthMethodLabel(type, key, method.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {currentSecrets &&
        Object.entries(currentSecrets).map(([key, coreFieldConfig]) => {
          const field = getUISecretField(type, key, coreFieldConfig);
          return (
            <div key={key} className="flex flex-col gap-3">
              <label className="text-sm font-medium text-foreground">
                {field.label}
                {!field.required && (
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    (optional)
                  </span>
                )}
              </label>
              <Input
                value={secrets[key] ?? ""}
                placeholder={field.placeholder ?? ""}
                onChange={(e) => onSecretFieldChange(key, e.target.value)}
                readOnly={isLoading}
                className={errors[key] ? "border-destructive" : ""}
              />
              {errors[key] && (
                <p className="text-xs text-destructive">{errors[key]}</p>
              )}
            </div>
          );
        })}

      <ModelSelector
        providerType={providerType}
        selectedModel={selectedModel}
        useDefaultModel={useDefaultModel}
        onModelChange={onModelChange}
        onUseDefaultModelChange={onUseDefaultModelChange}
      />
    </>
  );
}

function ModelSelector({
  providerType,
  selectedModel,
  useDefaultModel,
  onModelChange,
  onUseDefaultModelChange,
}: {
  providerType: string;
  selectedModel: string;
  useDefaultModel: boolean;
  onModelChange: (value: string) => void;
  onUseDefaultModelChange: (value: boolean) => void;
}) {
  const type = providerType as keyof typeof MODEL_PROVIDER_TYPES;

  if (!hasModelSelection(type)) {
    return null;
  }

  const models = getModels(type) ?? [];
  const defaultModel = getUIDefaultModel(type) ?? getDefaultModel(type) ?? "";
  const canCustom = allowsCustomModel(type);
  const placeholder = getCustomModelPlaceholder(type) ?? "Enter model name";

  if (canCustom && models.length === 0) {
    return (
      <>
        <div className="flex flex-col gap-3">
          <label className="text-sm font-medium text-foreground">Model</label>
          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">
                Default model
              </span>
              <span className="text-sm text-muted-foreground">
                When enabled, this uses the default model. Disable it to
                configure a custom one.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={useDefaultModel}
              onClick={() => onUseDefaultModelChange(!useDefaultModel)}
              className={`relative ml-4 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${useDefaultModel ? "bg-primary" : "bg-muted"}`}
            >
              <span
                className={`pointer-events-none inline-block size-5 rounded-full bg-white shadow-sm ring-0 transition-transform ${useDefaultModel ? "translate-x-5" : "translate-x-0.5"} mt-0.5`}
              />
            </button>
          </div>
        </div>
        {!useDefaultModel && (
          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium text-foreground">
              Custom model ID
            </label>
            <Input
              value={selectedModel}
              placeholder={placeholder}
              onChange={(e) => onModelChange(e.target.value)}
            />
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="text-sm font-medium text-foreground">
        Select model
      </label>
      <Select
        value={selectedModel || defaultModel}
        onValueChange={onModelChange}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select a model" />
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem key={model} value={model}>
              {model}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
