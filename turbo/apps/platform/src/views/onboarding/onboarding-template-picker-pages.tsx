import { useGet, useSet } from "ccstate-react";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
} from "@vm0/core";
import { cn } from "@vm0/ui";
import {
  onboardingDraft$,
  updateOnboardingDraft$,
  type OnboardingDraft,
} from "../../signals/onboarding/onboarding-state.ts";
import { ROUTES, type RoutePath } from "../../signals/route-paths.ts";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import { OnboardingFooter, OnboardingShell } from "./onboarding-shell.tsx";

type TemplateKind = "presentation" | "image" | "video";

interface TemplateCardData {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly imageUrl: string;
}

interface TemplatePickerConfig {
  readonly title: string;
  readonly description: string;
  readonly cards: readonly TemplateCardData[];
  readonly selectedSlug: string | null;
  readonly runPath: RoutePath;
}

function templatePickerConfig(
  kind: TemplateKind,
  selectedSlug: string | null,
): TemplatePickerConfig {
  if (kind === "presentation") {
    return {
      title: "Choose a presentation style",
      description:
        "Start with a complete visual system. You can change the content before the first run.",
      selectedSlug,
      runPath: ROUTES.onboardingPresentationRun,
      cards: PRESENTATION_TEMPLATE_PICKER_ITEMS.map((item) => {
        return {
          slug: item.slug,
          title: item.title,
          description: `${item.slideCount ?? item.previewImages.length} slide layout`,
          imageUrl: item.cardPreviewImage ?? item.previewImage,
        };
      }),
    };
  }
  if (kind === "image") {
    return {
      title: "Choose an illustration style",
      description:
        "Pick the visual language for your first image. The scene stays fully customizable.",
      selectedSlug,
      runPath: ROUTES.onboardingImageRun,
      cards: ILLUSTRATION_TEMPLATE_ITEMS.map((item) => {
        return {
          slug: item.slug,
          title: item.title,
          description: `${item.variationCount} style references`,
          imageUrl: item.cardPreviewImage ?? item.previewImage,
        };
      }),
    };
  }
  return {
    title: "Choose a video style",
    description:
      "Select a production style, then add direction for the story you want to tell.",
    selectedSlug,
    runPath: ROUTES.onboardingVideoRun,
    cards: VIDEO_TEMPLATE_ITEMS.map((item) => {
      return {
        slug: item.slug,
        title: item.title,
        description: item.description,
        imageUrl: item.cardPreviewImage ?? item.previewImage,
      };
    }),
  };
}

function selectedTemplateSlug(
  kind: TemplateKind,
  draft: OnboardingDraft,
): string | null {
  if (kind === "presentation") {
    return draft.presentationTemplateSlug;
  }
  if (kind === "image") {
    return draft.imageTemplateSlug;
  }
  return draft.videoTemplateSlug;
}

function OnboardingTemplatePickerPage({
  kind,
}: {
  readonly kind: TemplateKind;
}) {
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const { navigateTo } = useOnboardingNavigation();
  const selectedSlug = selectedTemplateSlug(kind, draft);
  const config = templatePickerConfig(kind, selectedSlug);
  const selectedCard = config.cards.find((card) => {
    return card.slug === selectedSlug;
  });

  const setSelectedSlug = (slug: string): void => {
    if (kind === "presentation") {
      setDraft({ presentationTemplateSlug: slug });
    } else if (kind === "image") {
      setDraft({ imageTemplateSlug: slug });
    } else {
      setDraft({ videoTemplateSlug: slug });
    }
  };

  const handleContinue = (): void => {
    if (!selectedSlug) {
      return;
    }
    navigateTo(config.runPath, {
      updates: { template: selectedSlug },
      remove: ["category", "workflow"],
    });
  };

  return (
    <OnboardingShell
      currentStep={2}
      totalSteps={3}
      title={config.title}
      description={config.description}
      preview={
        selectedCard ? (
          <img
            src={selectedCard.imageUrl}
            alt=""
            className="max-h-48 w-full rounded-lg object-contain"
          />
        ) : undefined
      }
      footer={
        <OnboardingFooter
          onBack={() => {
            navigateTo(ROUTES.onboarding);
          }}
          onPrimary={handleContinue}
          primaryLabel="Continue"
          primaryDisabled={!selectedSlug}
        />
      }
    >
      <div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        role="radiogroup"
        aria-label="Templates"
      >
        {config.cards.map((card) => {
          const selected = card.slug === selectedSlug;
          return (
            <button
              key={card.slug}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setSelectedSlug(card.slug);
              }}
              className={cn(
                "overflow-hidden rounded-lg border bg-background text-left transition-colors hover:border-[hsl(var(--gray-500))]",
                selected
                  ? "border-primary ring-2 ring-primary/15"
                  : "border-border",
              )}
            >
              <span className="block aspect-video w-full overflow-hidden bg-[hsl(var(--gray-100))]">
                <img
                  src={card.imageUrl}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              </span>
              <span className="block p-3">
                <span className="block truncate text-sm font-medium">
                  {card.title}
                </span>
                <span className="mt-1 block line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {card.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </OnboardingShell>
  );
}

export function OnboardingPresentationTemplatePage() {
  return <OnboardingTemplatePickerPage kind="presentation" />;
}

export function OnboardingImageTemplatePage() {
  return <OnboardingTemplatePickerPage kind="image" />;
}

export function OnboardingVideoTemplatePage() {
  return <OnboardingTemplatePickerPage kind="video" />;
}
