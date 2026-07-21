import { command, computed, state } from "ccstate";

export type OnboardingChoice =
  | "workflow"
  | "presentation"
  | "video"
  | "images"
  | "explore";

export type OnboardingRouteStep =
  | "make"
  | "workflow-picker"
  | "workflow-run"
  | "presentation-template"
  | "presentation-run"
  | "image-template"
  | "image-run"
  | "video-template"
  | "video-run";

export interface OnboardingDraft {
  readonly choice: OnboardingChoice | null;
  readonly categoryId: string | null;
  readonly workflowId: string | null;
  readonly workflowNote: string;
  readonly presentationTemplateSlug: string | null;
  readonly presentationNote: string;
  readonly imageTemplateSlug: string | null;
  readonly imageNote: string;
  readonly videoTemplateSlug: string | null;
  readonly videoNote: string;
  readonly prompt: string;
}

type OnboardingDraftUpdate = Partial<{
  -readonly [Key in keyof OnboardingDraft]: OnboardingDraft[Key];
}>;

function emptyOnboardingDraft(): OnboardingDraft {
  return {
    choice: null,
    categoryId: null,
    workflowId: null,
    workflowNote: "",
    presentationTemplateSlug: null,
    presentationNote: "",
    imageTemplateSlug: null,
    imageNote: "",
    videoTemplateSlug: null,
    videoNote: "",
    prompt: "",
  };
}

const internalOnboardingDraft$ = state<OnboardingDraft>(emptyOnboardingDraft());

export const onboardingDraft$ = computed((get) => {
  return get(internalOnboardingDraft$);
});

export const updateOnboardingDraft$ = command(
  ({ set }, patch: OnboardingDraftUpdate) => {
    set(internalOnboardingDraft$, (current) => {
      return { ...current, ...patch };
    });
  },
);

export const resetOnboardingDraft$ = command(({ set }) => {
  set(internalOnboardingDraft$, emptyOnboardingDraft());
});

function onboardingChoice(value: string | null): OnboardingChoice | null {
  if (
    value === "workflow" ||
    value === "presentation" ||
    value === "video" ||
    value === "images" ||
    value === "explore"
  ) {
    return value;
  }
  return null;
}

export const hydrateOnboardingRoute$ = command(
  ({ get, set }, step: OnboardingRouteStep, searchParams: URLSearchParams) => {
    const choice = onboardingChoice(searchParams.get("choice"));
    if (step === "make" && !choice) {
      set(resetOnboardingDraft$);
    }

    const current = get(internalOnboardingDraft$);
    const prompt = searchParams.get("prompt");
    const categoryId = searchParams.get("category");
    const workflowId = searchParams.get("workflow");
    const onboardingNote = searchParams.get("onboarding_note");
    const templateSlug =
      searchParams.get("onboarding_template") ?? searchParams.get("template");
    const patch: OnboardingDraftUpdate = {
      ...(choice ? { choice } : {}),
      ...(prompt !== null ? { prompt } : {}),
    };

    if (step === "workflow-picker" || step === "workflow-run") {
      patch.choice = "workflow";
      patch.categoryId = categoryId ?? current.categoryId;
      patch.workflowId = workflowId ?? current.workflowId;
    }
    if (step === "presentation-template" || step === "presentation-run") {
      patch.choice = "presentation";
      patch.presentationTemplateSlug =
        templateSlug ?? current.presentationTemplateSlug;
    }
    if (step === "image-template" || step === "image-run") {
      patch.choice = "images";
      patch.imageTemplateSlug = templateSlug ?? current.imageTemplateSlug;
    }
    if (step === "video-template" || step === "video-run") {
      patch.choice = "video";
      patch.videoTemplateSlug = templateSlug ?? current.videoTemplateSlug;
      if (onboardingNote !== null) {
        patch.videoNote = onboardingNote;
      }
    }

    set(updateOnboardingDraft$, patch);
  },
);
