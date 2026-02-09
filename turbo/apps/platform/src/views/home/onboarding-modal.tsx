import { useGet, useLoadable, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  DialogDescription,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
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
import { IconX, IconInfoCircle } from "@tabler/icons-react";
import { Loader2 } from "lucide-react";
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
import {
  showOnboardingModal$,
  closeOnboardingModal$,
  onboardingProviderType$,
  onboardingFormValues$,
  setOnboardingProviderType$,
  setOnboardingSecret$,
  setOnboardingModel$,
  setOnboardingUseDefaultModel$,
  setOnboardingAuthMethod$,
  setOnboardingSecretField$,
  saveOnboardingConfig$,
  canSaveOnboarding$,
  actionPromise$,
} from "../../signals/onboarding.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { theme$ } from "../../signals/theme.ts";
import { ClaudeCodeSetupPrompt } from "../settings-page/setup-prompt.tsx";
import { ProviderIcon } from "../settings-page/provider-icons.tsx";
import {
  getProviderShape,
  getUILabel,
  getUIDefaultModel,
  getUISecretField,
  getUIAuthMethodLabel,
} from "../settings-page/provider-ui-config.ts";

export function OnboardingModal() {
  const isOpen = useGet(showOnboardingModal$);
  const closeModal = useSet(closeOnboardingModal$);
  const providerType = useGet(onboardingProviderType$);
  const formValues = useGet(onboardingFormValues$);
  const setProviderType = useSet(setOnboardingProviderType$);
  const setSecret = useSet(setOnboardingSecret$);
  const setModel = useSet(setOnboardingModel$);
  const setUseDefaultModel = useSet(setOnboardingUseDefaultModel$);
  const setAuthMethod = useSet(setOnboardingAuthMethod$);
  const setSecretField = useSet(setOnboardingSecretField$);
  const saveConfig = useSet(saveOnboardingConfig$);
  const actionStatus = useLoadable(actionPromise$);
  const canSave =
    useGet(canSaveOnboarding$) && actionStatus.state !== "loading";
  const pageSignal = useGet(pageSignal$);
  const theme = useGet(theme$);

  const isLoading = actionStatus.state === "loading";
  const shape = getProviderShape(providerType);
  const providerTypes = Object.keys(
    MODEL_PROVIDER_TYPES,
  ) as ModelProviderType[];

  const backgroundGradient =
    theme === "dark"
      ? "linear-gradient(91deg, rgba(255, 200, 176, 0.15) 0%, rgba(166, 222, 255, 0.15) 51%, rgba(255, 231, 162, 0.15) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)"
      : "linear-gradient(91deg, rgba(255, 200, 176, 0.26) 0%, rgba(166, 222, 255, 0.26) 51%, rgba(255, 231, 162, 0.26) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)";

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeModal()}>
      <DialogContent
        className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden sm:max-h-[85dvh] sm:max-w-[600px] p-0 border-border rounded-[10px] [&>button[aria-label=Close]:last-child]:hidden"
        style={{
          backgroundImage: backgroundGradient,
        }}
      >
        {/* Close button - top row */}
        <div className="shrink-0 flex justify-end pr-3 pt-3 sm:pr-4 sm:pt-4">
          <DialogClose asChild>
            <button
              className="icon-button opacity-70 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              aria-label="Close"
            >
              <IconX size={20} className="text-foreground" />
            </button>
          </DialogClose>
        </div>

        {/* Fixed Header - Logo and Title */}
        <div className="shrink-0 px-4 pb-3 sm:px-6 sm:pb-4">
          {/* Logo */}
          <div className="flex items-center justify-center gap-2 mb-3 sm:mb-4">
            <img
              src={theme === "dark" ? "/logo_dark.svg" : "/logo_light.svg"}
              alt="VM0"
              className="h-[32px] sm:h-[40px] w-auto"
            />
            <span className="text-3xl sm:text-4xl font-normal text-foreground">
              Platform
            </span>
          </div>

          {/* Header */}
          <div className="text-center">
            <DialogTitle className="text-base sm:text-lg font-medium leading-6 sm:leading-7 text-foreground">
              Define your model provider
            </DialogTitle>
            <DialogDescription className="text-sm text-foreground mt-2">
              Your model provider is required for sandboxed execution.
            </DialogDescription>
          </div>
        </div>

        {/* Scrollable content area */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 flex flex-col gap-4 sm:gap-6 dialog-scrollable">
          {/* Provider Type Selector */}
          <div className="flex flex-col gap-2">
            <label className="px-1 text-sm font-medium text-foreground">
              Model provider
            </label>
            <Select
              value={providerType}
              onValueChange={(v) => setProviderType(v as ModelProviderType)}
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
            <OnboardingOAuthFields
              secret={formValues.secret}
              onSecretChange={setSecret}
              isLoading={isLoading}
            />
          )}

          {shape === "api-key" && (
            <OnboardingApiKeyFields
              providerType={providerType}
              secret={formValues.secret}
              selectedModel={formValues.selectedModel}
              useDefaultModel={formValues.useDefaultModel}
              onSecretChange={setSecret}
              onModelChange={setModel}
              onUseDefaultModelChange={setUseDefaultModel}
              isLoading={isLoading}
            />
          )}

          {shape === "multi-auth" && (
            <OnboardingMultiAuthFields
              providerType={providerType}
              authMethod={formValues.authMethod}
              secrets={formValues.secrets}
              selectedModel={formValues.selectedModel}
              useDefaultModel={formValues.useDefaultModel}
              onAuthMethodChange={setAuthMethod}
              onSecretFieldChange={setSecretField}
              onModelChange={setModel}
              onUseDefaultModelChange={setUseDefaultModel}
              isLoading={isLoading}
            />
          )}
        </div>

        {/* Fixed Footer - Action Buttons */}
        <div className="shrink-0 flex justify-end gap-2 px-4 pb-4 pt-3 sm:px-6 sm:pb-6 sm:pt-4 border-t border-border/50">
          <Button variant="outline" onClick={() => closeModal()}>
            Cancel
          </Button>
          <Button
            onClick={() => detach(saveConfig(pageSignal), Reason.DomCallback)}
            disabled={!canSave}
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OnboardingOAuthFields({
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
        Claude code OAuth token
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

function OnboardingApiKeyFields({
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
      <OnboardingModelSelector
        providerType={providerType}
        selectedModel={selectedModel}
        useDefaultModel={useDefaultModel}
        onModelChange={onModelChange}
        onUseDefaultModelChange={onUseDefaultModelChange}
      />
    </>
  );
}

function OnboardingMultiAuthFields({
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

      <OnboardingModelSelector
        providerType={providerType}
        selectedModel={selectedModel}
        useDefaultModel={useDefaultModel}
        onModelChange={onModelChange}
        onUseDefaultModelChange={onUseDefaultModelChange}
      />
    </>
  );
}

function OnboardingModelSelector({
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
