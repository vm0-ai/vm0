import { useGet, useLoadable, useSet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import { Loader2 } from "lucide-react";
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
import { navigateInReact$, searchParams$ } from "../../signals/route.ts";
import { ProviderFormFields } from "../shared/provider-form-fields.tsx";

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
  const currentSearchParams = useGet(searchParams$);
  const returnUrl = currentSearchParams.get("return");

  const isLoading = actionStatus.state === "loading";

  const backgroundGradient =
    theme === "dark"
      ? "linear-gradient(91deg, rgba(255, 200, 176, 0.15) 0%, rgba(166, 222, 255, 0.15) 51%, rgba(255, 231, 162, 0.15) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)"
      : "linear-gradient(91deg, rgba(255, 200, 176, 0.26) 0%, rgba(166, 222, 255, 0.26) 51%, rgba(255, 231, 162, 0.26) 100%), linear-gradient(90deg, hsl(var(--background)) 0%, hsl(var(--background)) 100%)";

  const navigateToDestination = () => {
    if (returnUrl) {
      const url = new URL(returnUrl, location.origin);
      navigate(url.pathname as Parameters<typeof navigate>[0], {
        searchParams: url.searchParams,
      });
    } else {
      navigate("/settings", {
        searchParams: new URLSearchParams({ tab: "integrations" }),
      });
    }
  };

  const handleContinue = () => {
    detach(
      (async () => {
        await saveConfig(pageSignal);
        navigateToDestination();
      })(),
      Reason.DomCallback,
    );
  };

  const handleLater = () => {
    navigateToDestination();
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
      style={{ backgroundImage: backgroundGradient }}
    >
      <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-border bg-popover p-10">
        <div className="flex flex-col items-center gap-8">
          {/* Logo */}
          <div className="flex items-center gap-2.5 p-1.5">
            <img
              src={theme === "dark" ? "/logo_dark.svg" : "/logo_light.svg"}
              alt="VM0"
              className="h-5 w-auto"
            />
            <span className="text-2xl font-normal leading-8 text-foreground">
              Platform
            </span>
          </div>

          {/* Content */}
          <div className="flex w-full flex-col gap-6">
            {/* Header */}
            <div className="flex flex-col gap-2.5 text-center text-foreground">
              <h1 className="text-lg font-medium leading-7">
                Define your model provider
              </h1>
              <p className="text-sm leading-5">
                Your model provider is required for sandboxed execution
              </p>
            </div>

            {/* Form Fields */}
            <ProviderFormFields
              providerType={providerType}
              formValues={formValues}
              onProviderTypeChange={setProviderType}
              onSecretChange={setSecret}
              onModelChange={setModel}
              onUseDefaultModelChange={setUseDefaultModel}
              onAuthMethodChange={setAuthMethod}
              onSecretFieldChange={setSecretField}
              isLoading={isLoading}
            />

            {/* Action Buttons */}
            <div className="flex flex-col gap-4">
              <Button
                className="w-full"
                onClick={handleContinue}
                disabled={!canSave}
              >
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Continue
              </Button>
              <Button
                className="w-full"
                variant="outline"
                onClick={handleLater}
              >
                Later
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
