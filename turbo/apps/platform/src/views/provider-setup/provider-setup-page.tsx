import { useGet, useLoadable, useSet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";
import { Loader2 } from "lucide-react";
import { MODEL_PROVIDER_TYPES, type ModelProviderType } from "@vm0/core";
import {
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
import { navigateInReact$ } from "../../signals/route.ts";
import { ProviderIcon } from "../settings-page/provider-icons.tsx";
import {
  getProviderShape,
  getUILabel,
} from "../settings-page/provider-ui-config.ts";
import {
  OnboardingOAuthFields,
  OnboardingApiKeyFields,
  OnboardingMultiAuthFields,
} from "../home/onboarding-modal.tsx";

export function ProviderSetupPage() {
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
  const navigate = useSet(navigateInReact$);

  const isLoading = actionStatus.state === "loading";
  const shape = getProviderShape(providerType);
  const providerTypes = Object.keys(
    MODEL_PROVIDER_TYPES,
  ) as ModelProviderType[];

  const backgroundGradient =
    theme === "dark"
      ? "linear-gradient(91deg, rgba(255, 200, 176, 0.15) 0%, rgba(166, 222, 255, 0.15) 51%, rgba(255, 231, 162, 0.15) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)"
      : "linear-gradient(91deg, rgba(255, 200, 176, 0.26) 0%, rgba(166, 222, 255, 0.26) 51%, rgba(255, 231, 162, 0.26) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)";

  const handleContinue = () => {
    detach(
      (async () => {
        await saveConfig(pageSignal);
        navigate("/settings", {
          searchParams: new URLSearchParams({ tab: "integrations" }),
        });
      })(),
      Reason.DomCallback,
    );
  };

  const handleLater = () => {
    navigate("/settings", {
      searchParams: new URLSearchParams({ tab: "integrations" }),
    });
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
      style={{ backgroundImage: backgroundGradient }}
    >
      <div className="w-full max-w-[600px] overflow-hidden rounded-xl border border-border bg-popover">
        <div className="flex flex-col gap-0">
          {/* Header - Logo and Title */}
          <div className="shrink-0 px-4 pt-6 pb-3 sm:px-6 sm:pt-8 sm:pb-4">
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
              <h1 className="text-base sm:text-lg font-medium leading-6 sm:leading-7 text-foreground">
                Define your model provider
              </h1>
              <p className="text-sm text-foreground mt-2">
                Your model provider is required for sandboxed execution.
              </p>
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6 flex flex-col gap-4 sm:gap-6">
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

          {/* Footer - Action Buttons */}
          <div className="shrink-0 flex justify-end gap-2 px-4 pb-4 pt-3 sm:px-6 sm:pb-6 sm:pt-4 border-t border-border/50">
            <Button variant="outline" onClick={handleLater}>
              Later
            </Button>
            <Button onClick={handleContinue} disabled={!canSave}>
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              Continue
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
