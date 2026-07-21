import { useGet, useSet } from "ccstate-react";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
} from "@vm0/core";
import {
  onboardingDraft$,
  updateOnboardingDraft$,
  type OnboardingDraft,
} from "../../signals/onboarding/onboarding-state.ts";
import { ROUTES, type RoutePath } from "../../signals/route-paths.ts";
import { useOnboardingNavigation } from "./onboarding-navigation.ts";
import { OnboardingRunAction } from "./onboarding-run-action.tsx";
import { OnboardingShell } from "./onboarding-shell.tsx";

type TemplateRunKind = "presentation" | "image" | "video";

type TemplateRunMedia =
  | {
      readonly kind: "presentation" | "image";
      readonly imageUrl: string;
    }
  | {
      readonly kind: "video";
      readonly imageUrl: string;
      readonly videoUrl: string;
    };

interface TemplateRunConfig {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly note: string;
  readonly noteLabel: string;
  readonly notePlaceholder: string;
  readonly templateSlug: string;
  readonly templateId: string;
  readonly backPath: RoutePath;
  readonly media: TemplateRunMedia;
  readonly requiresPaidPlan: boolean;
}

function withNote(basePrompt: string, label: string, note: string): string {
  const trimmedNote = note.trim();
  return trimmedNote
    ? `${basePrompt}\n\n${label}:\n${trimmedNote}`
    : basePrompt;
}

function presentationRunConfig(
  slug: string | null,
  note: string,
): TemplateRunConfig | null {
  const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
    return candidate.slug === slug;
  });
  if (!item) {
    return null;
  }
  return {
    title: item.title,
    description: "Add the subject and any facts the deck should include.",
    prompt: withNote(item.prompt, "Additional content and instruction", note),
    note,
    noteLabel: "Presentation brief (optional)",
    notePlaceholder:
      "e.g. A product launch deck for an analytics platform, aimed at operations leaders.",
    templateSlug: item.slug,
    templateId: `presentation-template:${item.slug}`,
    backPath: ROUTES.onboardingPresentationTemplate,
    media: {
      kind: "presentation",
      imageUrl: item.cardPreviewImage ?? item.previewImage,
    },
    requiresPaidPlan: false,
  };
}

function imageRunConfig(
  slug: string | null,
  note: string,
): TemplateRunConfig | null {
  const item = ILLUSTRATION_TEMPLATE_ITEMS.find((candidate) => {
    return candidate.slug === slug;
  });
  if (!item) {
    return null;
  }
  const basePrompt = `Generate an illustration in the ${item.title} style.`;
  return {
    title: item.title,
    description: "Describe the subject, composition, and details to include.",
    prompt: withNote(basePrompt, "Scene", note),
    note,
    noteLabel: "Scene (optional)",
    notePlaceholder:
      "e.g. A small creative team planning a launch around a sunlit studio table.",
    templateSlug: item.slug,
    templateId: `illustration-template:${item.slug}`,
    backPath: ROUTES.onboardingImageTemplate,
    media: {
      kind: "image",
      imageUrl: item.cardPreviewImage ?? item.previewImage,
    },
    requiresPaidPlan: false,
  };
}

function videoRunConfig(
  slug: string | null,
  note: string,
): TemplateRunConfig | null {
  const item = VIDEO_TEMPLATE_ITEMS.find((candidate) => {
    return candidate.slug === slug;
  });
  if (!item) {
    return null;
  }
  const basePrompt = `Create a ${item.title} video. ${item.description}`;
  return {
    title: item.title,
    description: "Add the story, product, or moment the video should capture.",
    prompt: withNote(basePrompt, "Additional direction", note),
    note,
    noteLabel: "Video brief (optional)",
    notePlaceholder:
      "e.g. A 20-second launch film for a compact travel camera, ending on the product name.",
    templateSlug: item.slug,
    templateId: item.id,
    backPath: ROUTES.onboardingVideoTemplate,
    media: {
      kind: "video",
      imageUrl: item.cardPreviewImage ?? item.previewImage,
      videoUrl: item.previewWebm,
    },
    requiresPaidPlan: true,
  };
}

function templateRunConfig(
  kind: TemplateRunKind,
  draft: OnboardingDraft,
): TemplateRunConfig | null {
  if (kind === "presentation") {
    return presentationRunConfig(
      draft.presentationTemplateSlug,
      draft.presentationNote,
    );
  }
  if (kind === "image") {
    return imageRunConfig(draft.imageTemplateSlug, draft.imageNote);
  }
  return videoRunConfig(draft.videoTemplateSlug, draft.videoNote);
}

function TemplateRunPreview({ media }: { readonly media: TemplateRunMedia }) {
  if (media.kind === "video") {
    return (
      <video
        src={media.videoUrl}
        poster={media.imageUrl}
        autoPlay
        muted
        loop
        playsInline
        className="aspect-video w-full rounded-lg bg-black object-cover"
      />
    );
  }
  return (
    <div className="flex max-h-[420px] min-h-56 items-center justify-center overflow-hidden rounded-lg bg-[hsl(var(--gray-100))] p-3">
      <img
        src={media.imageUrl}
        alt=""
        className="max-h-[390px] max-w-full object-contain"
      />
    </div>
  );
}

function OnboardingTemplateRunPage({
  kind,
}: {
  readonly kind: TemplateRunKind;
}) {
  const draft = useGet(onboardingDraft$);
  const setDraft = useSet(updateOnboardingDraft$);
  const { navigateTo } = useOnboardingNavigation();
  const config = templateRunConfig(kind, draft);

  if (!config) {
    return null;
  }

  const setNote = (note: string): void => {
    if (kind === "presentation") {
      setDraft({ presentationNote: note });
    } else if (kind === "image") {
      setDraft({ imageNote: note });
    } else {
      setDraft({ videoNote: note });
    }
  };

  const handleBack = (): void => {
    navigateTo(config.backPath, {
      updates: { template: config.templateSlug },
    });
  };

  return (
    <OnboardingShell
      currentStep={3}
      totalSteps={3}
      title={config.title}
      description={config.description}
      preview={
        <img
          src={config.media.imageUrl}
          alt=""
          className="max-h-48 w-full rounded-lg object-contain"
        />
      }
      footer={
        <OnboardingRunAction
          prompt={config.prompt}
          note={config.note}
          template={config.templateId}
          templateSlug={config.templateSlug}
          requiresPaidPlan={config.requiresPaidPlan}
          onBack={handleBack}
        />
      }
    >
      <TemplateRunPreview media={config.media} />
      <label
        className="mt-6 block text-sm font-medium"
        htmlFor={`${kind}-note`}
      >
        {config.noteLabel}
      </label>
      <textarea
        id={`${kind}-note`}
        value={config.note}
        onChange={(event) => {
          setNote(event.target.value);
        }}
        placeholder={config.notePlaceholder}
        className="mt-2 min-h-28 w-full resize-y rounded-lg border border-border bg-background px-4 py-3 text-sm leading-6 outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/15"
      />
    </OnboardingShell>
  );
}

export function OnboardingPresentationRunPage() {
  return <OnboardingTemplateRunPage kind="presentation" />;
}

export function OnboardingImageRunPage() {
  return <OnboardingTemplateRunPage kind="image" />;
}

export function OnboardingVideoRunPage() {
  return <OnboardingTemplateRunPage kind="video" />;
}
