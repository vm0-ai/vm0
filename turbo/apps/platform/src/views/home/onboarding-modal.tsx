import { useGet, useLoadable, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  DialogDescription,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { IconX } from "@tabler/icons-react";
import { Loader2 } from "lucide-react";
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
import { ProviderFormFields } from "../shared/provider-form-fields.tsx";

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
