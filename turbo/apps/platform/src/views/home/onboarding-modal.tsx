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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { IconX, IconLock, IconInfoCircle } from "@tabler/icons-react";
import { Loader2 } from "lucide-react";
import {
  showOnboardingModal$,
  closeOnboardingModal$,
  tokenValue$,
  setTokenValue$,
  saveOnboardingConfig$,
  canSaveOnboarding$,
  actionPromise$,
} from "../../signals/onboarding.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ClaudeCodeSetupPrompt } from "../settings-page/setup-prompt.tsx";

export function OnboardingModal() {
  const isOpen = useGet(showOnboardingModal$);
  const closeModal = useSet(closeOnboardingModal$);
  const tokenValue = useGet(tokenValue$);
  const setTokenValue = useSet(setTokenValue$);
  const saveConfig = useSet(saveOnboardingConfig$);
  const actionPromise = useLoadable(actionPromise$);
  const canSave =
    useGet(canSaveOnboarding$) && actionPromise.state !== "loading";
  const pageSignal = useGet(pageSignal$);

  return (
    <Dialog open={isOpen}>
      <DialogContent
        className="sm:max-w-[600px] p-6 border-border rounded-[10px]"
        style={{
          backgroundImage:
            "linear-gradient(91deg, rgba(255, 200, 176, 0.26) 0%, rgba(166, 222, 255, 0.26) 51%, rgba(255, 231, 162, 0.26) 100%), linear-gradient(90deg, rgb(255, 255, 255) 0%, rgb(255, 255, 255) 100%)",
        }}
      >
        {/* Close button */}
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DialogClose asChild>
                <button
                  onClick={() => closeModal()}
                  className="absolute right-4 top-4 icon-button opacity-70 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  aria-label="Close"
                >
                  <IconX size={20} className="text-foreground" />
                </button>
              </DialogClose>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">Close</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mt-[24px]">
          <img src="/logo_light.svg" alt="VM0" className="h-[40px] w-auto" />
          <span className="text-4xl font-normal text-foreground">Platform</span>
        </div>

        {/* Header */}
        <div className="text-center mt-[24px]">
          <DialogTitle className="text-lg font-medium leading-7 text-foreground">
            Define your model provider
          </DialogTitle>
          <DialogDescription className="text-sm text-foreground mt-[10px]">
            Claude Code OAuth token is required for Claude Code running in cloud
            sandboxes.
          </DialogDescription>
        </div>

        {/* Subscription Selection */}
        <div className="flex flex-col gap-6 mt-[24px]">
          {/* OAuth Token Input */}
          <div className="flex flex-col gap-2">
            <label className="px-1 text-sm font-medium text-foreground flex items-center gap-1.5">
              Claude Code OAuth token
              <TooltipProvider delayDuration={100}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="inline-flex">
                      <IconInfoCircle className="h-4 w-4 text-muted-foreground hover:text-foreground transition-colors" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[280px]">
                    <p className="text-xs">
                      Your token is encrypted and securely stored. It will only
                      be used for sandboxed execution and never shared with
                      third parties.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </label>
            <div className="relative flex items-center">
              <IconLock className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                className="flex-1 h-9 pl-9 font-mono"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
                placeholder="sk-ant-oat..."
                value={tokenValue}
                onChange={(e) => setTokenValue(e.target.value)}
                autoFocus
                required
              />
            </div>
            <ClaudeCodeSetupPrompt />
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-2 mt-[24px]">
          <Button variant="outline" onClick={() => closeModal()}>
            Add it later
          </Button>
          <Button
            onClick={() => detach(saveConfig(pageSignal), Reason.DomCallback)}
            disabled={!canSave}
          >
            {actionPromise.state === "loading" && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
