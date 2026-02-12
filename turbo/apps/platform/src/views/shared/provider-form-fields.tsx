import { Input } from "@vm0/ui/components/ui/input";
import { Switch } from "@vm0/ui/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { IconInfoCircle } from "@tabler/icons-react";
import {
  MODEL_PROVIDER_TYPES,
  getAuthMethodsForType,
  getSecretsForAuthMethod,
  getModels,
  getDefaultModel,
  hasModelSelection,
  allowsCustomModel,
  getCustomModelPlaceholder,
  type ModelProviderType,
} from "@vm0/core";
import { ProviderIcon } from "../settings-page/provider-icons.tsx";
import {
  getProviderShape,
  getUILabel,
  getUIDefaultModel,
  getUISecretField,
  getUIAuthMethodLabel,
} from "../settings-page/provider-ui-config.ts";
import { ClaudeCodeSetupPrompt } from "../settings-page/setup-prompt.tsx";

interface ProviderFormFieldsProps {
  providerType: ModelProviderType;
  formValues: {
    secret: string;
    selectedModel: string;
    useDefaultModel: boolean;
    authMethod: string;
    secrets: Record<string, string>;
  };
  onProviderTypeChange: (v: ModelProviderType) => void;
  onSecretChange: (v: string) => void;
  onModelChange: (v: string) => void;
  onUseDefaultModelChange: (v: boolean) => void;
  onAuthMethodChange: (v: string) => void;
  onSecretFieldChange: (key: string, value: string) => void;
  isLoading: boolean;
}

export function ProviderFormFields({
  providerType,
  formValues,
  onProviderTypeChange,
  onSecretChange,
  onModelChange,
  onUseDefaultModelChange,
  onAuthMethodChange,
  onSecretFieldChange,
  isLoading,
}: ProviderFormFieldsProps) {
  const shape = getProviderShape(providerType);
  const providerTypes = Object.keys(
    MODEL_PROVIDER_TYPES,
  ) as ModelProviderType[];

  return (
    <>
      {/* Provider Type Selector */}
      <div className="flex flex-col gap-2">
        <label className="px-1 text-sm font-medium text-foreground">
          Model provider
        </label>
        <Select
          value={providerType}
          onValueChange={(v) => onProviderTypeChange(v as ModelProviderType)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select a model provider" />
          </SelectTrigger>
          <SelectContent>
            {providerTypes.map((type) => (
              <SelectItem key={type} value={type}>
                <div className="flex items-center gap-2">
                  <ProviderIcon type={type} size={16} />
                  <span>{getUILabel(type)}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Dynamic form fields based on provider shape */}
      {shape === "oauth" && (
        <OAuthFields
          secret={formValues.secret}
          onSecretChange={onSecretChange}
          isLoading={isLoading}
        />
      )}

      {shape === "api-key" && (
        <ApiKeyFields
          providerType={providerType}
          secret={formValues.secret}
          selectedModel={formValues.selectedModel}
          useDefaultModel={formValues.useDefaultModel}
          onSecretChange={onSecretChange}
          onModelChange={onModelChange}
          onUseDefaultModelChange={onUseDefaultModelChange}
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
          onAuthMethodChange={onAuthMethodChange}
          onSecretFieldChange={onSecretFieldChange}
          onModelChange={onModelChange}
          onUseDefaultModelChange={onUseDefaultModelChange}
          isLoading={isLoading}
        />
      )}
    </>
  );
}

function OAuthFields({
  secret,
  onSecretChange,
  isLoading,
}: {
  secret: string;
  onSecretChange: (value: string) => void;
  isLoading: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="px-1 text-sm font-medium text-foreground flex items-center gap-1.5">
        Claude OAuth token
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="inline-flex">
                <IconInfoCircle className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[280px]">
              <p className="text-xs">
                Your token is encrypted and securely stored. It will only be
                used for sandboxed execution and never shared with third
                parties.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </label>
      <Input
        placeholder="sk-ant-oat..."
        value={secret}
        onChange={(e) => onSecretChange(e.target.value)}
        readOnly={isLoading}
      />
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
  isLoading,
}: {
  providerType: ModelProviderType;
  secret: string;
  selectedModel: string;
  useDefaultModel: boolean;
  onSecretChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onUseDefaultModelChange: (value: boolean) => void;
  isLoading: boolean;
}) {
  const config = MODEL_PROVIDER_TYPES[providerType];
  const fieldSecretLabel =
    "secretLabel" in config ? config.secretLabel : "API key";
  const helpText = "helpText" in config ? config.helpText : undefined;

  return (
    <>
      <div className="flex flex-col gap-2">
        <label className="px-1 text-sm font-medium text-foreground">
          {fieldSecretLabel}
        </label>
        <Input
          placeholder={`Enter your ${fieldSecretLabel}`}
          value={secret}
          onChange={(e) => onSecretChange(e.target.value)}
          readOnly={isLoading}
        />
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
  isLoading,
}: {
  providerType: ModelProviderType;
  authMethod: string;
  secrets: Record<string, string>;
  selectedModel: string;
  useDefaultModel: boolean;
  onAuthMethodChange: (value: string) => void;
  onSecretFieldChange: (key: string, value: string) => void;
  onModelChange: (value: string) => void;
  onUseDefaultModelChange: (value: boolean) => void;
  isLoading: boolean;
}) {
  const authMethods = getAuthMethodsForType(providerType);

  if (!authMethods) {
    return null;
  }

  const authMethodEntries = Object.entries(authMethods);
  const currentSecrets = authMethod
    ? getSecretsForAuthMethod(providerType, authMethod)
    : undefined;

  return (
    <>
      {authMethodEntries.length > 1 && (
        <div className="flex flex-col gap-2">
          <label className="px-1 text-sm font-medium text-foreground">
            Select authentication method
          </label>
          <Select value={authMethod} onValueChange={onAuthMethodChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select auth method" />
            </SelectTrigger>
            <SelectContent>
              {authMethodEntries.map(([key, method]) => (
                <SelectItem key={key} value={key}>
                  {getUIAuthMethodLabel(providerType, key, method.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {currentSecrets &&
        Object.entries(currentSecrets).map(([key, coreFieldConfig]) => {
          const field = getUISecretField(providerType, key, coreFieldConfig);
          return (
            <div key={key} className="flex flex-col gap-2">
              <label className="px-1 text-sm font-medium text-foreground">
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
              />
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
  providerType: ModelProviderType;
  selectedModel: string;
  useDefaultModel: boolean;
  onModelChange: (value: string) => void;
  onUseDefaultModelChange: (value: boolean) => void;
}) {
  if (!hasModelSelection(providerType)) {
    return null;
  }

  const models = getModels(providerType) ?? [];
  const defaultModel =
    getUIDefaultModel(providerType) ?? getDefaultModel(providerType) ?? "";
  const canCustom = allowsCustomModel(providerType);
  const placeholder =
    getCustomModelPlaceholder(providerType) ?? "Enter model name";

  if (canCustom && models.length === 0) {
    return (
      <>
        <div className="flex flex-col gap-2">
          <label className="px-1 text-sm font-medium text-foreground">
            Model
          </label>
          <div className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">
                Default model
              </span>
              <span className="text-sm text-muted-foreground">
                When enabled, this uses the default model. Disable it to
                configure a custom one.
              </span>
            </div>
            <Switch
              checked={useDefaultModel}
              onCheckedChange={onUseDefaultModelChange}
              className="ml-4"
            />
          </div>
        </div>
        {!useDefaultModel && (
          <div className="flex flex-col gap-2">
            <label className="px-1 text-sm font-medium text-foreground">
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
    <div className="flex flex-col gap-2">
      <label className="px-1 text-sm font-medium text-foreground">
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
