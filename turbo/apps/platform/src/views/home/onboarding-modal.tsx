import { useGet, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import {
  showOnboardingModal$,
  onboardingComplete$,
  closeOnboardingModal$,
} from "../../signals/scope.ts";

export function OnboardingModal() {
  const isOpen = useGet(showOnboardingModal$);
  const isComplete = useGet(onboardingComplete$);
  const closeModal = useSet(closeOnboardingModal$);

  return (
    <Dialog open={isOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isComplete ? "Welcome to vm0!" : "Setting up your account"}
          </DialogTitle>
          <DialogDescription>
            {isComplete
              ? "Your account is ready. You can now start using the platform."
              : "Please wait while we prepare your workspace..."}
          </DialogDescription>
        </DialogHeader>
        {isComplete && (
          <DialogFooter>
            <Button onClick={() => closeModal()}>Get Started</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
