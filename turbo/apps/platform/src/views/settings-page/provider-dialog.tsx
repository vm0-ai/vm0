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
import { IconLock } from "@tabler/icons-react";
import {
  MODEL_PROVIDER_TYPES,
  getProviderShape,
  getAuthMethodsForType,
  getSecretsForAuthMethod,
  getModels,
  getDefaultModel,
  hasModelSelection,
  allowsCustomModel,
  getCustomModelPlaceholder,
} from "@vm0/core";
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
  const pageSignal = useGet(pageSignal$);

  if (!dialog.providerType) {
    return (
      <Dialog open={dialog.open} onOpenChange={() => close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Model Provider</DialogTitle>
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

  const handleSubmit = () => {
    detach(submit(pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog open={dialog.open} onOpenChange={() => close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${config.label}` : `Add ${config.label}`}
          </DialogTitle>
          {"helpText" in config && config.helpText && (
            <DialogDescription className="whitespace-pre-line">
              {config.helpText}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {shape === "oauth" && (
            <OAuthFields
              secret={formValues.secret}
              onSecretChange={setSecret}
              error={errors["secret"]}
              isEdit={isEdit}
              isLoading={isLoading}
            />
          )}

          {shape === "api-key" && (
            <ApiKeyFields
              providerType={providerType}
              secret={formValues.secret}
              selectedModel={formValues.selectedModel}
              onSecretChange={setSecret}
              onModelChange={setModel}
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
              onAuthMethodChange={setAuthMethod}
              onSecretFieldChange={setSecretField}
              onModelChange={setModel}
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
            {isLoading ? "Saving..." : "Save"}
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
  isEdit,
  isLoading,
}: {
  secret: string;
  onSecretChange: (value: string) => void;
  error?: string;
  isEdit: boolean;
  isLoading: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-foreground">OAuth token</label>
      <div className="relative flex items-center">
        <IconLock className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={secret}
          placeholder={isEdit ? "Enter new token to update" : "sk-ant-oat-..."}
          onChange={(e) => onSecretChange(e.target.value)}
          readOnly={isLoading}
          className={`pl-9 font-mono ${error ? "border-destructive" : ""}`}
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <ClaudeCodeSetupPrompt />
    </div>
  );
}

function ApiKeyFields({
  providerType,
  secret,
  selectedModel,
  onSecretChange,
  onModelChange,
  error,
  isEdit,
  isLoading,
}: {
  providerType: string;
  secret: string;
  selectedModel: string;
  onSecretChange: (value: string) => void;
  onModelChange: (value: string) => void;
  error?: string;
  isEdit: boolean;
  isLoading: boolean;
}) {
  const config =
    MODEL_PROVIDER_TYPES[providerType as keyof typeof MODEL_PROVIDER_TYPES];
  const secretLabel = "secretLabel" in config ? config.secretLabel : "API key";

  return (
    <>
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">
          {secretLabel}
        </label>
        <div className="relative flex items-center">
          <IconLock className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={secret}
            placeholder={
              isEdit
                ? `Enter new ${secretLabel} to update`
                : `Enter your ${secretLabel}`
            }
            onChange={(e) => onSecretChange(e.target.value)}
            readOnly={isLoading}
            className={`pl-9 font-mono ${error ? "border-destructive" : ""}`}
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <ModelSelector
        providerType={providerType}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
      />
    </>
  );
}

function MultiAuthFields({
  providerType,
  authMethod,
  secrets,
  selectedModel,
  onAuthMethodChange,
  onSecretFieldChange,
  onModelChange,
  errors,
  isLoading,
}: {
  providerType: string;
  authMethod: string;
  secrets: Record<string, string>;
  selectedModel: string;
  onAuthMethodChange: (value: string) => void;
  onSecretFieldChange: (key: string, value: string) => void;
  onModelChange: (value: string) => void;
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
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-foreground">
            Authentication method
          </label>
          <Select value={authMethod} onValueChange={onAuthMethodChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select auth method" />
            </SelectTrigger>
            <SelectContent>
              {authMethodEntries.map(([key, method]) => (
                <SelectItem key={key} value={key}>
                  {method.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {currentSecrets &&
        Object.entries(currentSecrets).map(([key, fieldConfig]) => (
          <div key={key} className="flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">
              {fieldConfig.label}
              {!fieldConfig.required && (
                <span className="text-muted-foreground font-normal">
                  {" "}
                  (optional)
                </span>
              )}
            </label>
            <div className="relative flex items-center">
              <IconLock className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                value={secrets[key] ?? ""}
                placeholder={fieldConfig.placeholder ?? ""}
                onChange={(e) => onSecretFieldChange(key, e.target.value)}
                readOnly={isLoading}
                className={`pl-9 font-mono ${errors[key] ? "border-destructive" : ""}`}
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              />
            </div>
            {fieldConfig.helpText && (
              <p className="text-xs text-muted-foreground">
                {fieldConfig.helpText}
              </p>
            )}
            {errors[key] && (
              <p className="text-xs text-destructive">{errors[key]}</p>
            )}
          </div>
        ))}

      <ModelSelector
        providerType={providerType}
        selectedModel={selectedModel}
        onModelChange={onModelChange}
      />
    </>
  );
}

function ModelSelector({
  providerType,
  selectedModel,
  onModelChange,
}: {
  providerType: string;
  selectedModel: string;
  onModelChange: (value: string) => void;
}) {
  const type = providerType as keyof typeof MODEL_PROVIDER_TYPES;

  if (!hasModelSelection(type)) {
    return null;
  }

  const models = getModels(type) ?? [];
  const defaultModel = getDefaultModel(type) ?? "";
  const canCustom = allowsCustomModel(type);
  const placeholder = getCustomModelPlaceholder(type) ?? "Enter model name";

  if (canCustom && models.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-foreground">Model</label>
        <Input
          value={selectedModel}
          placeholder={placeholder}
          onChange={(e) => onModelChange(e.target.value)}
          className="font-mono"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-foreground">Model</label>
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
