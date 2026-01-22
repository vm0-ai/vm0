import { useGet, useSet, useLastResolved } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { scope$ } from "../../signals/scope.ts";
import {
  showOnboardingModal$,
  closeOnboardingModal$,
} from "../../signals/onboarding.ts";

export function OnboardingModal() {
  const isOpen = useGet(showOnboardingModal$);
  const scope = useLastResolved(scope$);
  const closeModal = useSet(closeOnboardingModal$);

  const isComplete = scope !== undefined;

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
