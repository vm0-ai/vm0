import { command, computed, state } from "ccstate";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { localStorageSignals } from "../external/local-storage.ts";
import { jsonParseOr } from "../utils.ts";

// ---------------------------------------------------------------------------
// Composer UI state — search, dialogs, loading indicators
// ---------------------------------------------------------------------------

// -- Slash workflow picker --------------------------------------------------

const internalSlashWorkflowCaretIndex$ = state(0);
export const slashWorkflowCaretIndex$ = computed((get) => {
  return get(internalSlashWorkflowCaretIndex$);
});
export const setSlashWorkflowCaretIndex$ = command(
  ({ set }, caretIndex: number) => {
    set(internalSlashWorkflowCaretIndex$, caretIndex);
  },
);

const internalSlashWorkflowEditorFocused$ = state(false);
export const slashWorkflowEditorFocused$ = computed((get) => {
  return get(internalSlashWorkflowEditorFocused$);
});
export const setSlashWorkflowEditorFocused$ = command(
  ({ set }, focused: boolean) => {
    set(internalSlashWorkflowEditorFocused$, focused);
  },
);

const internalSelectedSlashWorkflowIndex$ = state(0);
export const selectedSlashWorkflowIndex$ = computed((get) => {
  return get(internalSelectedSlashWorkflowIndex$);
});
export const setSelectedSlashWorkflowIndex$ = command(
  ({ set }, index: number) => {
    set(internalSelectedSlashWorkflowIndex$, index);
  },
);

// -- New-thread Computer Use host selection ---------------------------------

const internalNewThreadComputerUseHostId$ = state<string | null>(null);
export const newThreadComputerUseHostId$ = computed((get) => {
  return get(internalNewThreadComputerUseHostId$);
});
export const setNewThreadComputerUseHostId$ = command(
  ({ set }, hostId: string | null) => {
    set(internalNewThreadComputerUseHostId$, hostId);
  },
);

// -- Model picker open state ------------------------------------------------

const internalModelPickerOpen$ = state(false);
export const modelPickerOpen$ = computed((get) => {
  return get(internalModelPickerOpen$);
});
export const setModelPickerOpen$ = command(({ set }, open: boolean) => {
  set(internalModelPickerOpen$, open);
});

// -- Template picker open/category state ------------------------------------

const internalTemplatePickerOpen$ = state(false);
export const templatePickerOpen$ = computed((get) => {
  return get(internalTemplatePickerOpen$);
});
export const setTemplatePickerOpen$ = command(({ set }, open: boolean) => {
  set(internalTemplatePickerOpen$, open);
});

const internalTemplatePickerReferenceValue$ =
  state<GenerationTemplateRequest | null>(null);
export const templatePickerReferenceValue$ = computed((get) => {
  return get(internalTemplatePickerReferenceValue$);
});
export const setTemplatePickerReferenceValue$ = command(
  ({ set }, value: GenerationTemplateRequest | null) => {
    set(internalTemplatePickerReferenceValue$, value);
  },
);

const internalWebsiteTemplatePreviewId$ = state<string | null>(null);
export const websiteTemplatePreviewId$ = computed((get) => {
  return get(internalWebsiteTemplatePreviewId$);
});
export const openWebsiteTemplatePreview$ = command(
  ({ set }, templateId: string) => {
    set(internalWebsiteTemplatePreviewId$, templateId);
  },
);
export const closeWebsiteTemplatePreview$ = command(({ set }) => {
  set(internalWebsiteTemplatePreviewId$, null);
});

const internalUploadPopoverOpen$ = state(false);
export const uploadPopoverOpen$ = computed((get) => {
  return get(internalUploadPopoverOpen$);
});
export const setUploadPopoverOpen$ = command(({ set }, open: boolean) => {
  set(internalUploadPopoverOpen$, open);
});

const internalTemplatePickerCategory$ = state("slides");
export const templatePickerCategory$ = computed((get) => {
  return get(internalTemplatePickerCategory$);
});
export const setTemplatePickerCategory$ = command(
  ({ set }, category: string) => {
    set(internalTemplatePickerCategory$, category);
  },
);

const internalTemplatePickerSearch$ = state("");
export const templatePickerSearch$ = computed((get) => {
  return get(internalTemplatePickerSearch$);
});
export const setTemplatePickerSearch$ = command(({ set }, value: string) => {
  set(internalTemplatePickerSearch$, value);
});

// Selected persona pill in the workflow template tab ("all" or a category from
// WORKFLOW_TEMPLATE_CATEGORIES). Mirrors the ideation gallery's pill filter.
const internalTemplatePickerWorkflowCategory$ = state("all");
export const templatePickerWorkflowCategory$ = computed((get) => {
  return get(internalTemplatePickerWorkflowCategory$);
});
export const setTemplatePickerWorkflowCategory$ = command(
  ({ set }, category: string) => {
    set(internalTemplatePickerWorkflowCategory$, category);
  },
);

const internalTemplatePickerPreviewSlug$ = state<string | null>(null);
export const templatePickerPreviewSlug$ = computed((get) => {
  return get(internalTemplatePickerPreviewSlug$);
});
export const setTemplatePickerPreviewSlug$ = command(
  ({ set }, slug: string | null) => {
    set(internalTemplatePickerPreviewSlug$, slug);
  },
);

const internalTemplatePickerPresentationScrollTop$ = state(0);
export const setTemplatePickerPresentationScrollTop$ = command(
  ({ set }, scrollTop: number) => {
    set(internalTemplatePickerPresentationScrollTop$, scrollTop);
  },
);
export const restoreTemplatePickerPresentationScroll$ = command(
  ({ get }, node: HTMLElement) => {
    node.scrollTop = get(internalTemplatePickerPresentationScrollTop$);
  },
);

// Inline illustration cards show a hero image plus a variant thumbnail strip.
// Several cards are visible at once, so the active variant index is tracked per
// illustration style slug rather than as a single shared value.
const internalIllustrationVariantIndex$ = state<
  Readonly<Record<string, number>>
>({});
export const illustrationVariantIndex$ = computed((get) => {
  return get(internalIllustrationVariantIndex$);
});
export const setIllustrationVariantIndex$ = command(
  ({ get, set }, slug: string, index: number) => {
    set(internalIllustrationVariantIndex$, {
      ...get(internalIllustrationVariantIndex$),
      [slug]: index,
    });
  },
);

// Hover scrubbing on template cards. Only one card is hovered at a time, so a
// single signal tracks the active card's slug plus the scrubbed slide index;
// each card resolves its own index by matching the stored slug.
interface TemplateCardHoverState {
  readonly slug: string;
  readonly index: number;
}

const internalTemplateCardHover$ = state<TemplateCardHoverState | null>(null);
export const templateCardHover$ = computed((get) => {
  return get(internalTemplateCardHover$);
});
export const setTemplateCardHover$ = command(
  ({ set }, value: TemplateCardHoverState | null) => {
    set(internalTemplateCardHover$, value);
  },
);

export interface TemplateCardHtmlPreviewState {
  readonly slug: string;
  readonly embedUrl: string;
  readonly themeId: string;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly frameUrl: string | null;
  readonly slideCount: number;
}

const internalTemplateCardHtmlPreview$ =
  state<TemplateCardHtmlPreviewState | null>(null);
export const templateCardHtmlPreview$ = computed((get) => {
  return get(internalTemplateCardHtmlPreview$);
});
export const setTemplateCardHtmlPreview$ = command(
  ({ set }, value: TemplateCardHtmlPreviewState | null) => {
    set(internalTemplateCardHtmlPreview$, value);
  },
);

const internalTemplateCardDefaultHtmlPreviews$ = state<
  Readonly<Record<string, TemplateCardHtmlPreviewState>>
>({});
export const templateCardDefaultHtmlPreviews$ = computed((get) => {
  return get(internalTemplateCardDefaultHtmlPreviews$);
});
export const setTemplateCardDefaultHtmlPreview$ = command(
  ({ get, set }, embedUrl: string, value: TemplateCardHtmlPreviewState) => {
    set(internalTemplateCardDefaultHtmlPreviews$, {
      ...get(internalTemplateCardDefaultHtmlPreviews$),
      [embedUrl]: value,
    });
  },
);

const internalTemplateCardLoadedHtmlFrameUrls$ = state<
  Readonly<Record<string, string>>
>({});
export const templateCardLoadedHtmlFrameUrls$ = computed((get) => {
  return get(internalTemplateCardLoadedHtmlFrameUrls$);
});
export const setTemplateCardLoadedHtmlFrameUrl$ = command(
  ({ get, set }, key: string, frameUrl: string) => {
    set(internalTemplateCardLoadedHtmlFrameUrls$, {
      ...get(internalTemplateCardLoadedHtmlFrameUrls$),
      [key]: frameUrl,
    });
  },
);

const internalTemplateCardThemeIdBySlug$ = state<
  Readonly<Record<string, string>>
>({});
const {
  get$: templateCardThemeIdBySlugRaw$,
  set$: setTemplateCardThemeIdBySlugRaw$,
} = localStorageSignals("presentationTemplateThemeIdBySlug");

function parseTemplateCardThemeIdBySlug(
  raw: string | null,
): Readonly<Record<string, string>> {
  if (raw === null) {
    return {};
  }
  const parsed = jsonParseOr<unknown>(raw, {});
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const values: Record<string, string> = {};
  for (const [slug, themeId] of Object.entries(parsed)) {
    if (typeof themeId === "string") {
      values[slug] = themeId;
    }
  }
  return values;
}

export const templateCardThemeIdBySlug$ = computed((get) => {
  return {
    ...parseTemplateCardThemeIdBySlug(get(templateCardThemeIdBySlugRaw$)),
    ...get(internalTemplateCardThemeIdBySlug$),
  };
});
export const setTemplateCardThemeId$ = command(
  ({ get, set }, slug: string, themeId: string) => {
    const next = {
      ...get(templateCardThemeIdBySlug$),
      [slug]: themeId,
    };
    set(internalTemplateCardThemeIdBySlug$, next);
    set(setTemplateCardThemeIdBySlugRaw$, JSON.stringify(next));
  },
);

interface TemplateDetailHtmlPreviewState {
  readonly slug: string;
  readonly embedUrl: string;
  readonly themeId: string;
  readonly index: number;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly frameUrl: string | null;
  readonly slideCount: number;
}

const internalTemplateDetailHtmlPreview$ =
  state<TemplateDetailHtmlPreviewState | null>(null);
export const templateDetailHtmlPreview$ = computed((get) => {
  return get(internalTemplateDetailHtmlPreview$);
});
export const setTemplateDetailHtmlPreview$ = command(
  ({ set }, value: TemplateDetailHtmlPreviewState | null) => {
    set(internalTemplateDetailHtmlPreview$, value);
  },
);

const internalTemplateDetailThemeIdBySlug$ = state<
  Readonly<Record<string, string>>
>({});
export const templateDetailThemeIdBySlug$ = computed((get) => {
  return get(internalTemplateDetailThemeIdBySlug$);
});
export const setTemplateDetailThemeId$ = command(
  ({ get, set }, slug: string, themeId: string) => {
    set(internalTemplateDetailThemeIdBySlug$, {
      ...get(internalTemplateDetailThemeIdBySlug$),
      [slug]: themeId,
    });
  },
);

const internalTemplateDetailSlideIndexBySlug$ = state<
  Readonly<Record<string, number>>
>({});
export const templateDetailSlideIndexBySlug$ = computed((get) => {
  return get(internalTemplateDetailSlideIndexBySlug$);
});
export const setTemplateDetailSlideIndex$ = command(
  ({ get, set }, slug: string, index: number) => {
    set(internalTemplateDetailSlideIndexBySlug$, {
      ...get(internalTemplateDetailSlideIndexBySlug$),
      [slug]: index,
    });
  },
);

// -- Per-message generation template selections --------------------------------

const internalNewThreadGenerationTemplate$ = state<
  GenerationTemplateRequest | undefined
>(undefined);
export const newThreadGenerationTemplate$ = computed((get) => {
  return get(internalNewThreadGenerationTemplate$);
});
export const setNewThreadGenerationTemplate$ = command(
  ({ set }, value: GenerationTemplateRequest | undefined) => {
    set(internalNewThreadGenerationTemplate$, value);
  },
);
