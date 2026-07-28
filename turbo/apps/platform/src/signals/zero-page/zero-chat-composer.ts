import { command, computed, state } from "ccstate";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import type { PresentationTemplateItem } from "@vm0/core";
import { localStorageSignals } from "../external/local-storage.ts";
import { jsonParseOr, tapError } from "../utils.ts";
import type {
  PresentationTemplateDetailSelection,
  TemplatePreviewRuntime,
} from "./template-preview-runtime.ts";
import {
  parsePresentationPreviewDraft,
  previewPresentationHtml,
  type PresentationPreviewDraft,
} from "../../views/zero-page/presentation-html-preview.ts";
import { readableAttachmentResourceUrl } from "../../views/zero-page/zero-attachment-url.ts";

// ---------------------------------------------------------------------------
// Composer UI state — search, dialogs, loading indicators
// ---------------------------------------------------------------------------

// -- New-thread computer access selection -----------------------------------

const internalNewThreadComputerUseHostId$ = state<string | null>(null);
const internalNewThreadCloudBrowserEnabled$ = state(false);

export const newThreadComputerUseHostId$ = computed((get) => {
  return get(internalNewThreadComputerUseHostId$);
});
export const newThreadCloudBrowserEnabled$ = computed((get) => {
  return get(internalNewThreadCloudBrowserEnabled$);
});

export const setNewThreadComputerUseHostId$ = command(
  ({ set }, hostId: string | null) => {
    set(internalNewThreadComputerUseHostId$, hostId);
    if (hostId) {
      set(internalNewThreadCloudBrowserEnabled$, false);
    }
  },
);

export const setNewThreadCloudBrowserEnabled$ = command(
  ({ set }, enabled: boolean) => {
    set(internalNewThreadCloudBrowserEnabled$, enabled);
    if (enabled) {
      set(internalNewThreadComputerUseHostId$, null);
    }
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

const internalWebsiteTemplatePreviewId$ = state<string | null>(null);
const internalTemplatePickerOpen$ = state(false);
export const templatePickerOpen$ = computed((get) => {
  return (
    get(internalTemplatePickerOpen$) &&
    get(internalWebsiteTemplatePreviewId$) === null
  );
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

const internalTemplateDetailThemeIdBySlug$ = state<
  Readonly<Record<string, string>>
>({});
export const templateDetailThemeIdBySlug$ = computed((get) => {
  return get(internalTemplateDetailThemeIdBySlug$);
});

const internalTemplateDetailSlideIndexBySlug$ = state<
  Readonly<Record<string, number>>
>({});
export const templateDetailSlideIndexBySlug$ = computed((get) => {
  return get(internalTemplateDetailSlideIndexBySlug$);
});

function presentationTemplateFallbackSlideCount(
  item: PresentationTemplateItem,
): number {
  return Math.max(item.slideCount ?? item.previewImages.length, 1);
}

function presentationTemplateDetailPreviewState(params: {
  readonly draft: PresentationPreviewDraft;
  readonly item: PresentationTemplateItem;
  readonly selection: PresentationTemplateDetailSelection;
}): TemplateDetailHtmlPreviewState {
  const slide =
    params.draft.slides[
      Math.min(params.selection.index, params.draft.slides.length - 1)
    ];
  if (slide === undefined) {
    throw new Error("Presentation template preview draft has no slides");
  }
  const frameUrl = URL.createObjectURL(
    new Blob(
      [
        previewPresentationHtml({
          activeSlideId: slide.id,
          additionalHeadStyle: params.selection.themeCss,
          html: params.draft.html,
        }),
      ],
      { type: "text/html;charset=utf-8" },
    ),
  );
  return {
    slug: params.item.slug,
    embedUrl: params.item.embedUrl,
    themeId: params.selection.themeId,
    index: params.selection.index,
    loading: false,
    failed: false,
    frameUrl,
    slideCount: params.draft.slides.length,
  };
}

const replaceTemplateDetailHtmlPreview$ = command(
  (
    { set },
    runtime: TemplatePreviewRuntime,
    value: TemplateDetailHtmlPreviewState | null,
  ) => {
    if (runtime.presentation.detailFrameUrl !== null) {
      URL.revokeObjectURL(runtime.presentation.detailFrameUrl);
    }
    runtime.presentation.detailFrameUrl = value?.frameUrl ?? null;
    set(internalTemplateDetailHtmlPreview$, value);
  },
);

const applyPresentationTemplateDetailSelection$ = command(
  (
    { get, set },
    runtime: TemplatePreviewRuntime,
    item: PresentationTemplateItem,
    selection: PresentationTemplateDetailSelection,
  ) => {
    runtime.presentation.activeDetail = selection;
    set(internalTemplateDetailThemeIdBySlug$, {
      ...get(internalTemplateDetailThemeIdBySlug$),
      [item.slug]: selection.themeId,
    });
    set(internalTemplateDetailSlideIndexBySlug$, {
      ...get(internalTemplateDetailSlideIndexBySlug$),
      [item.slug]: selection.index,
    });

    const draft = runtime.presentation.drafts.get(item.embedUrl);
    if (draft !== undefined) {
      set(
        replaceTemplateDetailHtmlPreview$,
        runtime,
        presentationTemplateDetailPreviewState({
          draft,
          item,
          selection,
        }),
      );
      return;
    }

    const failed = runtime.presentation.failed.has(item.embedUrl);
    set(replaceTemplateDetailHtmlPreview$, runtime, {
      slug: item.slug,
      embedUrl: item.embedUrl,
      themeId: selection.themeId,
      index: selection.index,
      loading: !failed,
      failed,
      frameUrl: null,
      slideCount: presentationTemplateFallbackSlideCount(item),
    });
  },
);

export async function loadPresentationTemplateHtmlPreview(params: {
  readonly item: PresentationTemplateItem;
  readonly signal: AbortSignal;
}): Promise<PresentationPreviewDraft | null> {
  const response = await fetch(
    readableAttachmentResourceUrl(params.item.embedUrl),
    {
      credentials: "omit",
      mode: "cors",
      signal: params.signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to load template HTML (${response.status})`);
  }

  const draft = parsePresentationPreviewDraft(await response.text());
  return draft.slides.length > 0 ? draft : null;
}

interface PresentationTemplateDetailSelectionParams {
  readonly index: number;
  readonly item: PresentationTemplateItem;
  readonly runtime: TemplatePreviewRuntime;
  readonly themeCss: string;
  readonly themeId: string;
}

export const openPresentationTemplateDetailPreview$ = command(
  async (
    { set },
    params: PresentationTemplateDetailSelectionParams,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const cache = params.runtime.presentation;
    if (cache.detailOwnerSignal !== signal) {
      cache.detailOwnerSignal = signal;
      signal.addEventListener(
        "abort",
        () => {
          if (cache.detailOwnerSignal !== signal) {
            return;
          }
          cache.activeDetail = null;
          cache.detailOwnerSignal = null;
          if (cache.detailFrameUrl !== null) {
            URL.revokeObjectURL(cache.detailFrameUrl);
            cache.detailFrameUrl = null;
          }
        },
        { once: true },
      );
    }
    const token = Symbol(params.item.embedUrl);
    const selection: PresentationTemplateDetailSelection = {
      embedUrl: params.item.embedUrl,
      index: params.index,
      slug: params.item.slug,
      themeCss: params.themeCss,
      themeId: params.themeId,
      token,
    };
    set(
      applyPresentationTemplateDetailSelection$,
      params.runtime,
      params.item,
      selection,
    );
    set(internalTemplatePickerPreviewSlug$, params.item.slug);

    if (
      cache.drafts.has(params.item.embedUrl) ||
      cache.failed.has(params.item.embedUrl)
    ) {
      return;
    }

    let pendingLoad = cache.pendingLoads.get(params.item.embedUrl);
    if (pendingLoad === undefined) {
      pendingLoad = loadPresentationTemplateHtmlPreview({
        item: params.item,
        signal,
      });
      cache.pendingLoads.set(params.item.embedUrl, pendingLoad);
    }

    const result = await tapError(
      pendingLoad.finally(() => {
        if (cache.pendingLoads.get(params.item.embedUrl) === pendingLoad) {
          cache.pendingLoads.delete(params.item.embedUrl);
        }
      }),
    );
    signal.throwIfAborted();

    if (result === undefined || result === null) {
      cache.failed.add(params.item.embedUrl);
    } else {
      cache.drafts.set(params.item.embedUrl, result);
    }

    const activeDetail = cache.activeDetail;
    if (activeDetail?.token !== token) {
      return;
    }
    set(
      applyPresentationTemplateDetailSelection$,
      params.runtime,
      params.item,
      activeDetail,
    );
  },
);

export const selectPresentationTemplateDetailPreview$ = command(
  ({ set }, params: PresentationTemplateDetailSelectionParams) => {
    const activeDetail = params.runtime.presentation.activeDetail;
    if (
      activeDetail === null ||
      activeDetail.embedUrl !== params.item.embedUrl ||
      activeDetail.slug !== params.item.slug
    ) {
      return;
    }
    set(
      applyPresentationTemplateDetailSelection$,
      params.runtime,
      params.item,
      {
        ...activeDetail,
        index: params.index,
        themeCss: params.themeCss,
        themeId: params.themeId,
      },
    );
  },
);

export const closePresentationTemplateDetailPreview$ = command(
  ({ set }, runtime: TemplatePreviewRuntime) => {
    runtime.presentation.activeDetail = null;
    set(replaceTemplateDetailHtmlPreview$, runtime, null);
    set(internalTemplatePickerPreviewSlug$, null);
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
