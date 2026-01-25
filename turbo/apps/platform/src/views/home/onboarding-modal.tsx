import { useGet, useSet } from "ccstate-react";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogTitle,
  DialogDescription,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui/components/ui/button";
import { Input } from "@vm0/ui/components/ui/input";
import { IconX } from "@tabler/icons-react";
import {
  showOnboardingModal$,
  closeOnboardingModal$,
  tokenValue$,
  setTokenValue$,
  saveOnboardingConfig$,
  copyStatus$,
  copyToClipboard$,
  canSaveOnboarding$,
} from "../../signals/onboarding.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

export function OnboardingModal() {
  const isOpen = useGet(showOnboardingModal$);
  const closeModal = useSet(closeOnboardingModal$);
  const tokenValue = useGet(tokenValue$);
  const setTokenValue = useSet(setTokenValue$);
  const saveConfig = useSet(saveOnboardingConfig$);
  const copyStatus = useGet(copyStatus$);
  const copyToClipboard = useSet(copyToClipboard$);
  const canSave = useGet(canSaveOnboarding$);
  const pageSignal = useGet(pageSignal$);

  return (
    <Dialog open={isOpen}>
      <DialogContent
        className="sm:max-w-[600px] p-6 gap-4 border-border rounded-[10px]"
        style={{
          backgroundImage:
            "linear-gradient(91deg, rgba(255, 200, 176, 0.26) 0%, rgba(166, 222, 255, 0.26) 51%, rgba(255, 231, 162, 0.26) 100%), linear-gradient(90deg, rgb(255, 255, 255) 0%, rgb(255, 255, 255) 100%)",
        }}
      >
        {/* Close button */}
        <DialogClose asChild>
          <button
            onClick={() => detach(closeModal(pageSignal), Reason.DomCallback)}
            className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <IconX className="h-6 w-6 text-foreground" />
            <span className="sr-only">Close</span>
          </button>
        </DialogClose>

        {/* Illustration */}
        <div className="flex justify-center">
          <img
            src="/images/onboarding/time-is-money.png"
            alt="Setup illustration"
            className="h-[120px] w-[153px] object-cover"
          />
        </div>

        {/* Header */}
        <div className="text-center">
          <DialogTitle className="text-lg font-medium leading-7 text-foreground">
            First, tell us how your LLM works and which model
            <br />
            is used to power your agent.
          </DialogTitle>
          <DialogDescription className="sr-only">
            Configure your LLM subscription and OAuth token
          </DialogDescription>
        </div>

        {/* Subscription Selection */}
        <div className="flex flex-col gap-6">
          {/* OAuth Token Input */}
          <div className="flex flex-col gap-2">
            <label className="px-1 text-sm font-medium text-foreground">
              Your OAuth token is needed to driven claude code in sandboxes.
            </label>
            <div className="flex gap-2">
              <Input
                className="flex-1 h-9"
                placeholder="sk-ant-oat..."
                value={tokenValue}
                onChange={(e) => setTokenValue(e.target.value)}
                required
              />
            </div>
            <p className="text-xs text-muted-foreground">
              You can find it by enter{" "}
              <code
                className="cursor-pointer rounded bg-muted px-1 py-0.5 font-mono hover:bg-muted/80 active:bg-muted/60"
                onClick={() => {
                  detach(
                    copyToClipboard("claude setup-token"),
                    Reason.DomCallback,
                  );
                }}
                title="Click to copy"
              >
                {copyStatus === "copied" ? "copied!" : "claude setup-token"}
              </code>{" "}
              in your terminal
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => detach(closeModal(pageSignal), Reason.DomCallback)}
          >
            Add it later
          </Button>
          <Button
            onClick={() => detach(saveConfig(pageSignal), Reason.DomCallback)}
            disabled={!canSave}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
