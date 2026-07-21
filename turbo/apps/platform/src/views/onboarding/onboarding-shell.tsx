import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  IconArrowLeft,
  IconArrowRight,
  IconLoader2,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { VM0Logo } from "../components/vm0-logo.tsx";
import { AccountDropdown } from "../zero-page/zero-sidebar.tsx";
import { SettingsDialog } from "../zero-page/components/settings/settings-dialog.tsx";
import { handleZeroAccountAction$ } from "../../signals/zero-page/zero-nav.ts";
import {
  closeSettingsModal$,
  settingsDialogOpen$,
} from "../../signals/zero-page/settings/settings-dialog.ts";

const ZERO_ONBOARDING_IMAGE =
  "https://static.vm0.io/web/assets/onboarding/2026-07-15/zero-animated-192.webp";

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
      className="grid h-1.5 w-full grid-flow-col gap-1.5"
      aria-label={`Step ${current} of ${total}`}
    >
      {Array.from({ length: total }, (_, index) => {
        return (
          <span
            key={index}
            className={
              index < current
                ? "rounded-sm bg-primary"
                : "rounded-sm bg-[hsl(var(--gray-200))]"
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
    <div className="flex w-full items-center justify-between gap-3">
      {onBack ? (
        <Button type="button" variant="ghost" onClick={onBack}>
          <IconArrowLeft aria-hidden="true" />
          Back
        </Button>
      ) : (
        <span />
      )}
      <Button
        type="button"
        onClick={onPrimary}
        disabled={primaryDisabled || busy}
        aria-busy={busy}
        className="min-w-28"
      >
        {busy ? (
          <IconLoader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <IconArrowRight aria-hidden="true" />
        )}
        {primaryLabel}
      </Button>
    </div>
  );
}

export function OnboardingShell({
  currentStep,
  totalSteps,
  title,
  description,
  children,
  footer,
  preview,
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
    <div className="zero-app zero-viewport-shell flex w-full bg-background text-foreground">
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeSettings();
          }
        }}
      />
      <aside className="zero-nav hidden h-full w-[300px] shrink-0 flex-col border-r border-border bg-[hsl(var(--gray-50))] p-5 md:flex">
        <div className="shrink-0 p-1">
          <VM0Logo />
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-5 text-center">
          {preview ?? (
            <img
              src={ZERO_ONBOARDING_IMAGE}
              alt="Zero"
              width={144}
              height={144}
              className="h-36 w-36 object-contain"
            />
          )}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Your first run with Zero</p>
            <p className="text-xs leading-5 text-muted-foreground">
              Pick a starting point and launch it in your workspace.
            </p>
          </div>
        </div>
        <div className="shrink-0">
          <OnboardingAccount collapsed={false} />
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4 md:hidden">
          <VM0Logo />
          <OnboardingAccount collapsed />
        </header>
        <div className="mx-auto flex min-h-0 w-full max-w-[980px] flex-1 flex-col px-4 sm:px-8">
          <div className="shrink-0 pt-5 sm:pt-8">
            <OnboardingProgress current={currentStep} total={totalSteps} />
          </div>
          <main
            key={`${currentStep}-${title}`}
            className="min-h-0 flex-1 overflow-y-auto py-7 sm:py-10"
          >
            <div className="mx-auto w-full max-w-[820px]">
              <header className="mb-7">
                <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                  Step {currentStep} of {totalSteps}
                </p>
                <h1 className="text-2xl font-semibold leading-8 sm:text-3xl sm:leading-10">
                  {title}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {description}
                </p>
              </header>
              {children}
            </div>
          </main>
          <footer className="shrink-0 border-t border-border py-4 sm:py-5">
            {footer}
          </footer>
        </div>
      </section>
    </div>
  );
}
