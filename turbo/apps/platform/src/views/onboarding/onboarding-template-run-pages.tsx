import type { SyntheticEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  r2ImageTransformUrl,
  VIDEO_TEMPLATE_ITEMS,
} from "@vm0/core";
import {
  onboardingDraft$,
  updateOnboardingDraft$,
  type OnboardingDraft,
} from "../../signals/onboarding/onboarding-state.ts";
import { ROUTES, type RoutePath } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { onboardingVideoPrompt } from "./onboarding-data.ts";
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
    title: "Fulfil your presentation",
    prompt: withNote(item.prompt, "Additional content and instruction", note),
    note,
    noteLabel: "Presentation content and instruction",
    notePlaceholder: "Add your presentation's content and instruction",
    templateSlug: item.slug,
    templateId: `presentation-template:${item.slug}`,
    backPath: ROUTES.onboardingPresentationTemplate,
    media: {
      kind: "presentation",
      imageUrl: item.previewImages[0] ?? item.previewImage,
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
    title: "Select one automation you would like to have a try",
    prompt: withNote(basePrompt, "Scene", note),
    note,
    noteLabel: "Custom illustration scene",
    notePlaceholder:
      "Add your custom scene to remix with your own illustration",
    templateSlug: item.slug,
    templateId: `illustration-template:${item.slug}`,
    backPath: ROUTES.onboardingImageTemplate,
    media: {
      kind: "image",
      imageUrl: item.previewImage,
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
  return {
    title: "Customize your video",
    prompt: withNote(
      onboardingVideoPrompt(item.slug),
      "Additional direction",
      note,
    ),
    note,
    noteLabel: "Custom video prompt",
    notePlaceholder: "Add your custom prompt to remix with your own video",
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

function playVideo(event: SyntheticEvent<HTMLElement>): void {
  const video = event.currentTarget.querySelector("video");
  if (video) {
    detach(video.play(), Reason.DomCallback);
  }
}

function resetVideo(event: SyntheticEvent<HTMLElement>): void {
  const video = event.currentTarget.querySelector("video");
  if (video) {
    video.pause();
    video.currentTime = 0;
  }
}

function TemplateRunPreview({ media }: { readonly media: TemplateRunMedia }) {
  if (media.kind === "video") {
    return (
      <section
        aria-label="Video template preview"
        tabIndex={0}
        className="mt-6 h-[200px] w-full max-w-[350px] overflow-hidden rounded-3xl border border-border bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onFocus={playVideo}
        onBlur={resetVideo}
        onMouseEnter={playVideo}
        onMouseLeave={resetVideo}
      >
        <video
          muted
          loop
          playsInline
          preload="metadata"
          poster={media.imageUrl}
          className="h-full w-full object-cover"
        >
          <source src={media.videoUrl} type="video/webm; codecs=vp9" />
        </video>
      </section>
    );
  }
  if (media.kind === "presentation") {
    return (
      <section
        aria-label="Presentation template preview"
        className="mt-6 h-[136px] w-[242px] overflow-hidden rounded-3xl border border-border bg-muted shadow-sm"
      >
        <img
          src={r2ImageTransformUrl(media.imageUrl, { width: 484 })}
          alt=""
          className="h-full w-full object-cover"
        />
      </section>
    );
  }
  return (
    <section
      aria-label="Illustration template preview"
      className="mt-5 h-[225px] w-[167px] overflow-hidden rounded-3xl bg-muted"
    >
      <img
        src={r2ImageTransformUrl(media.imageUrl, { width: 334 })}
        alt=""
        className="h-full w-full object-cover"
      />
    </section>
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
      description=""
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
      <div className="mt-6 flex w-full flex-col rounded-3xl border border-border bg-background px-6 pb-6">
        <label className="sr-only" htmlFor={`${kind}-note`}>
          {config.noteLabel}
        </label>
        <textarea
          id={`${kind}-note`}
          value={config.note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
          placeholder={config.notePlaceholder}
          rows={5}
          className="mt-[18px] min-h-32 w-full resize-y rounded-xl border border-border bg-background p-3 text-sm leading-5 outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
      </div>
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
