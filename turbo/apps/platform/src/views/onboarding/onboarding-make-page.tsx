import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { cn } from "@vm0/ui";
import { completeOnboarding$ } from "../../signals/onboarding/onboarding-actions.ts";
import {
  onboardingDraft$,
  updateOnboardingDraft$,
  type OnboardingChoice,
} from "../../signals/onboarding/onboarding-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { OnboardingConnectorSetup } from "./onboarding-connectors.tsx";
import { ONBOARDING_MAKE_OPTIONS } from "./onboarding-data.ts";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import { OnboardingFooter, OnboardingShell } from "./onboarding-shell.tsx";

const BRANCH_STATE_PARAMS = [
  "category",
  "workflow",
  "template",
  "onboarding_billing",
  "onboarding_billing_session_id",
  "onboarding_note",
  "onboarding_template",
] as const;

function choicePath(choice: OnboardingChoice) {
  switch (choice) {
    case "workflow": {
      return ROUTES.onboardingWorkflowPicker;
    }
    case "presentation": {
      return ROUTES.onboardingPresentationTemplate;
    }
    case "video": {
      return ROUTES.onboardingVideoTemplate;
    }
    case "images": {
      return ROUTES.onboardingImageTemplate;
    }
    case "explore": {
      return ROUTES.home;
    }
  }
}

function PromptOnboarding() {
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const [completeLoadable, complete] = useLoadableSet(completeOnboarding$);
  const searchParams = useGet(searchParams$);
  const pageSignal = useGet(pageSignal$);
  const { runPrompt } = useOnboardingNavigation();
  const connectors = (searchParams.get("connector") ?? "")
    .split(",")
    .map((value) => {
      return value.trim();
    })
    .filter(Boolean);

  const handleRun = (): void => {
    const redeemCode = searchParams.get("redeemCode")?.trim() || null;
    const completeAndRun = async (): Promise<void> => {
      await complete(redeemCode, pageSignal);
      runPrompt(draft.prompt);
    };
    detach(completeAndRun(), Reason.DomCallback);
  };

  return (
    <OnboardingShell
      currentStep={1}
      totalSteps={1}
      title="Start your first task"
      description="Review the request, connect any tools it needs, and send it to Zero."
      footer={
        <OnboardingFooter
          onPrimary={handleRun}
          primaryLabel="Run now"
          primaryDisabled={!draft.prompt.trim()}
          busy={completeLoadable.state === "loading"}
        />
      }
    >
      <label className="block text-sm font-medium" htmlFor="onboarding-prompt">
        Request
      </label>
      <textarea
        id="onboarding-prompt"
        value={draft.prompt}
        onChange={(event) => {
          setDraft({ prompt: event.target.value });
        }}
        className="mt-2 min-h-36 w-full resize-y rounded-lg border border-border bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15"
      />
      <OnboardingConnectorSetup connectorIds={connectors} />
    </OnboardingShell>
  );
}

export function OnboardingMakePage() {
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const [completeLoadable, complete] = useLoadableSet(completeOnboarding$);
  const searchParams = useGet(searchParams$);
  const pageSignal = useGet(pageSignal$);
  const { navigateTo } = useOnboardingNavigation();

  if (searchParams.has("prompt")) {
    return <PromptOnboarding />;
  }

  const handleContinue = (): void => {
    if (!draft.choice) {
      return;
    }
    if (draft.choice === "explore") {
      const redeemCode = searchParams.get("redeemCode")?.trim() || null;
      const completeAndOpenHome = async (): Promise<void> => {
        await complete(redeemCode, pageSignal);
        navigateTo(ROUTES.home, { preserve: false, replace: true });
      };
      detach(completeAndOpenHome(), Reason.DomCallback);
      return;
    }
    navigateTo(choicePath(draft.choice), {
      remove: BRANCH_STATE_PARAMS,
      updates: { choice: draft.choice },
    });
  };

  return (
    <OnboardingShell
      currentStep={1}
      totalSteps={3}
      title="What do you want to make first?"
      description="Pick a starting point. Everything else stays available after onboarding."
      footer={
        <OnboardingFooter
          onPrimary={handleContinue}
          primaryLabel={draft.choice === "explore" ? "Open VM0" : "Continue"}
          primaryDisabled={!draft.choice}
          busy={completeLoadable.state === "loading"}
        />
      }
    >
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        role="radiogroup"
        aria-label="First project type"
      >
        {ONBOARDING_MAKE_OPTIONS.map((option) => {
          const selected = draft.choice === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setDraft({ choice: option.id });
              }}
              className={cn(
                "flex min-h-24 items-center gap-4 rounded-lg border bg-background p-4 text-left transition-colors",
                "hover:border-[hsl(var(--gray-500))] hover:bg-[hsl(var(--gray-50))]",
                selected
                  ? "border-primary ring-2 ring-primary/15"
                  : "border-border",
                option.id === "workflow" && "sm:col-span-2",
              )}
            >
              <img
                src={option.imageUrl}
                alt=""
                width={48}
                height={48}
                className="h-12 w-12 shrink-0 object-contain"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {option.title}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </OnboardingShell>
  );
}
