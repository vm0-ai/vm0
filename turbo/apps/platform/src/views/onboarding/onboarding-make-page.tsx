import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Textarea, cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { completeOnboarding$ } from "../../signals/onboarding/onboarding-actions.ts";
import {
  ONBOARDING_CHECKOUT_STATE_PARAM,
  onboardingDraft$,
  updateOnboardingDraft$,
  type OnboardingChoice,
} from "../../signals/onboarding/onboarding-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { searchParams$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { OnboardingConnectorSetup } from "./onboarding-connectors.tsx";
import { onboardingMakeOptions } from "./onboarding-data.ts";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import {
  ONBOARDING_TEXTAREA_CLASS,
  OnboardingFooter,
  OnboardingShell,
} from "./onboarding-shell.tsx";

const BRANCH_STATE_PARAMS = [
  "category",
  "workflow",
  "template",
  "onboarding_billing",
  "onboarding_billing_session_id",
  "onboarding_note",
  "onboarding_template",
  ONBOARDING_CHECKOUT_STATE_PARAM,
] as const;

function choicePath(choice: OnboardingChoice) {
  switch (choice) {
    case "slack": {
      return ROUTES.works;
    }
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
  const { t } = useTranslation();
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const [completeLoadable, complete] = useLoadableSet(completeOnboarding$);
  const searchParams = useGet(searchParams$);
  const pageSignal = useGet(pageSignal$);
  const { runPrompt } = useOnboardingNavigation();
  const template = searchParams.get("template")?.trim() || undefined;
  const connectorSlugs = (searchParams.get("connector") ?? "")
    .split(",")
    .map((value) => {
      return value.trim();
    })
    .filter(Boolean);

  const handleRun = (): void => {
    const redeemCode = searchParams.get("redeemCode")?.trim() || null;
    const completeAndRun = async (): Promise<void> => {
      await complete(redeemCode, pageSignal);
      runPrompt(draft.prompt, template);
    };
    detach(completeAndRun(), Reason.DomCallback);
  };

  return (
    <OnboardingShell
      currentStep={1}
      totalSteps={1}
      title={t(($) => {
        return $.onboarding.make.promptTitle;
      })}
      description={t(($) => {
        return $.onboarding.make.promptDescription;
      })}
      footer={
        <OnboardingFooter
          onPrimary={handleRun}
          primaryLabel={t(($) => {
            return $.onboarding.common.next;
          })}
          primaryDisabled={!draft.prompt.trim()}
          busy={completeLoadable.state === "loading"}
        />
      }
    >
      <OnboardingConnectorSetup
        connectorSlugs={connectorSlugs}
        variant="prompt"
      />
      <Textarea
        id="onboarding-prompt"
        aria-label={t(($) => {
          return $.onboarding.make.promptLabel;
        })}
        value={draft.prompt}
        onChange={(event) => {
          setDraft({ prompt: event.target.value });
        }}
        className={cn(
          ONBOARDING_TEXTAREA_CLASS,
          "mt-6 min-h-28 resize-none px-4 py-3 leading-[1.625]",
        )}
      />
    </OnboardingShell>
  );
}

function SlackChoiceIllustration() {
  return (
    <svg
      data-testid="onboarding-slack-illustration"
      aria-hidden="true"
      viewBox="0 0 40 40"
      className="h-10 w-10 shrink-0"
    >
      <path
        fill="#3EB7B8"
        d="M5.3 10.7C6.7 5.4 12.1 3.4 18 4.2c5.8.8 13.7 1.8 16.2 6.8 2.7 5.4.5 14.7-3 19.5-3.7 5-12.6 5.6-18.3 2.8-5.6-2.8-10.1-7.9-9.3-13.5.4-3.3.9-6.2 1.7-9.1Z"
      />
      <path
        fill="white"
        stroke="#263238"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.2"
        d="M10.4 9.3c4.4-3.4 12.4-3.1 17 .1 5 3.4 6.2 10.5 3.2 15.3-3 4.8-9.8 7.2-15.2 5.5l-6.8 3.9 1.6-6.1c-5.1-4-4.9-14.8.2-18.7Z"
      />
      <path
        fill="none"
        stroke="#263238"
        strokeLinecap="round"
        strokeWidth="3.2"
        d="M19.6 13.3c-.1 1.5 0 2.7.1 4.1m-2.6 2-4.1.2m7.2 3.1.2 4.2m2.4-6 4.2-.2"
      />
      <path
        fill="#263238"
        d="M15.1 14.2a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0Zm13.3 1a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0ZM15.7 25.8a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0Zm13.2-.4a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0Z"
      />
    </svg>
  );
}

export function OnboardingMakePage() {
  const { t } = useTranslation();
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const [completeLoadable, complete] = useLoadableSet(completeOnboarding$);
  const searchParams = useGet(searchParams$);
  const pageSignal = useGet(pageSignal$);
  const { navigateTo } = useOnboardingNavigation();
  const makeOptions = onboardingMakeOptions(t);

  if (searchParams.has("prompt")) {
    return <PromptOnboarding />;
  }

  const handleChoice = (choice: OnboardingChoice): void => {
    setDraft({ choice });
    if (choice === "slack" || choice === "explore") {
      const redeemCode = searchParams.get("redeemCode")?.trim() || null;
      const completeAndOpenDestination = async (): Promise<void> => {
        await complete(redeemCode, pageSignal);
        navigateTo(choicePath(choice), { preserve: false, replace: true });
      };
      detach(completeAndOpenDestination(), Reason.DomCallback);
      return;
    }
    navigateTo(choicePath(choice), {
      remove: BRANCH_STATE_PARAMS,
      updates: { choice },
    });
  };

  return (
    <OnboardingShell
      currentStep={1}
      totalSteps={3}
      title={t(($) => {
        return $.onboarding.make.title;
      })}
      description={t(($) => {
        return $.onboarding.make.description;
      })}
    >
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        role="radiogroup"
        aria-label={t(($) => {
          return $.onboarding.make.projectTypeLabel;
        })}
      >
        {makeOptions.map((option) => {
          const selected = draft.choice === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                handleChoice(option.id);
              }}
              disabled={completeLoadable.state === "loading"}
              aria-busy={selected && completeLoadable.state === "loading"}
              className={cn(
                "flex min-h-[72px] items-center gap-3 rounded-xl border bg-background px-4 py-3.5 text-left shadow-[var(--zero-card-shadow)] transition-colors sm:px-6 sm:py-[15px]",
                "hover:border-primary/55",
                selected ? "border-primary" : "border-border",
              )}
            >
              {option.imageUrl ? (
                <img
                  src={option.imageUrl}
                  alt=""
                  width={48}
                  height={48}
                  className="h-10 w-10 shrink-0 object-contain"
                />
              ) : (
                <SlackChoiceIllustration />
              )}
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {option.title}
                </span>
                <span className="mt-0.5 block text-sm leading-5 text-muted-foreground">
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
