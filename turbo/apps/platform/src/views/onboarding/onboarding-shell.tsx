import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { IconLoader2 } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import { AccountDropdown } from "../zero-page/zero-sidebar.tsx";
import {
  ZeroOrgSwitcher,
  ZeroOrgSwitcherCompact,
} from "../zero-page/zero-org-switcher.tsx";
import { SettingsDialog } from "../zero-page/components/settings/settings-dialog.tsx";
import { handleZeroAccountAction$ } from "../../signals/zero-page/zero-nav.ts";
import {
  closeSettingsModal$,
  settingsDialogOpen$,
} from "../../signals/zero-page/settings/settings-dialog.ts";

function OnboardingAccount({ collapsed }: { readonly collapsed: boolean }) {
  const onAccountAction = useSet(handleZeroAccountAction$);
  return (
    <AccountDropdown
      onAccountAction={onAccountAction}
      settingsOwnerId={collapsed ? "onboarding-mobile" : "onboarding-desktop"}
      collapsed={collapsed}
    />
  );
}

function OnboardingProgress({
  current,
  total,
}: {
  readonly current: number;
  readonly total: number;
}) {
  return (
    <div
      className="flex h-1 w-full gap-1.5"
      aria-label={`Step ${current} of ${total}`}
    >
      {Array.from({ length: total }, (_, index) => {
        return (
          <span
            key={index}
            data-testid="onboarding-progress-step"
            className={
              index < current
                ? "flex-1 rounded-full bg-foreground"
                : "flex-1 rounded-full bg-muted"
            }
          />
        );
      })}
    </div>
  );
}

export function OnboardingFooter({
  onBack,
  onPrimary,
  primaryLabel,
  primaryDisabled = false,
  busy = false,
}: {
  readonly onBack?: () => void;
  readonly onPrimary: () => void;
  readonly primaryLabel: string;
  readonly primaryDisabled?: boolean;
  readonly busy?: boolean;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3 pl-16 sm:pl-0">
      {onBack ? (
        <button
          type="button"
          className="h-10 border-0 bg-transparent px-0 text-sm font-medium text-primary hover:text-[hsl(var(--primary-800))]"
          onClick={onBack}
        >
          Back
        </button>
      ) : (
        <span />
      )}
      <button
        type="button"
        onClick={onPrimary}
        disabled={primaryDisabled || busy}
        aria-busy={busy}
        className="inline-flex h-10 min-w-[100px] items-center justify-center gap-2 rounded-lg bg-primary px-6 text-sm font-medium text-white hover:bg-[hsl(var(--primary-800))] disabled:cursor-not-allowed disabled:bg-[hsl(var(--primary-500))]"
      >
        {busy ? (
          <IconLoader2 size={16} className="animate-spin" aria-hidden="true" />
        ) : null}
        {primaryLabel}
      </button>
    </div>
  );
}

export function OnboardingDialog({
  title,
  description,
  children,
  footer,
  onClose,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent
        overlayClassName="bg-black/45 backdrop-blur-sm dark:bg-black/45"
        className="flex max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-4xl flex-col gap-0 overflow-hidden rounded-lg border-border bg-background p-5 sm:p-6"
      >
        <header className="shrink-0 pr-9">
          <div className="min-w-0">
            <DialogTitle className="text-lg font-semibold leading-6">
              {title}
            </DialogTitle>
            {description ? (
              <DialogDescription className="mt-1 text-sm leading-5 text-muted-foreground">
                {description}
              </DialogDescription>
            ) : (
              <DialogDescription className="sr-only">
                {title} preview
              </DialogDescription>
            )}
          </div>
        </header>
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? (
          <footer className="mt-5 flex shrink-0 justify-end gap-2">
            {footer}
          </footer>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function OnboardingShell({
  currentStep,
  totalSteps,
  title,
  description,
  children,
  footer,
}: {
  readonly currentStep: number;
  readonly totalSteps: number;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly preview?: ReactNode;
}) {
  const settingsOpen = useGet(settingsDialogOpen$);
  const closeSettings = useSet(closeSettingsModal$);

  return (
    <div className="zero-app zero-viewport-shell relative w-full bg-background text-foreground">
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeSettings();
          }
        }}
      />
      <div className="fixed left-4 top-4 z-20 hidden w-60 sm:left-6 sm:top-6 sm:block">
        <ZeroOrgSwitcher />
      </div>
      <div className="fixed left-4 top-4 z-20 sm:hidden">
        <ZeroOrgSwitcherCompact />
      </div>
      <div className="fixed bottom-6 left-4 z-20 hidden w-60 sm:block">
        <OnboardingAccount collapsed={false} />
      </div>
      <div className="fixed bottom-8 left-6 z-20 sm:hidden">
        <OnboardingAccount collapsed />
      </div>

      <section className="mx-auto flex h-full min-h-0 w-full max-w-[750px] flex-col">
        <div className="shrink-0 px-5 pb-4 pt-[72px] sm:px-10 lg:pt-8">
          <OnboardingProgress current={currentStep} total={totalSteps} />
        </div>
        <main
          key={`${currentStep}-${title}`}
          className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-[50px] [scrollbar-width:none] sm:px-10 [&::-webkit-scrollbar]:hidden"
        >
          <header>
            <h1 className="text-2xl font-semibold leading-[1.25]">{title}</h1>
            {description ? (
              <p className="mb-6 mt-2 text-sm leading-[1.625] text-muted-foreground">
                {description}
              </p>
            ) : null}
          </header>
          {children}
        </main>
        <footer className="shrink-0 border-t border-border/40 px-5 py-5 sm:px-10">
          {footer}
        </footer>
      </section>
    </div>
  );
}
