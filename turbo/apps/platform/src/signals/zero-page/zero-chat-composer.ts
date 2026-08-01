import { command, computed, state } from "ccstate";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import type { PresentationTemplateItem } from "@vm0/core";
import { localStorageSignals } from "../external/local-storage.ts";
import { zeroBrowserEnabled$ } from "../external/feature-switch.ts";
import { jsonParseOr, tapError } from "../utils.ts";
import type { TemplatePreviewRuntime } from "./template-preview-runtime.ts";
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

// A thread reaches at most one computer, so the composer holds a single
// selection rather than two flags that have to clear each other.
type NewThreadComputerAccess =
  | { readonly kind: "none" }
  | { readonly kind: "cloudBrowser" }
  | { readonly kind: "computerUse"; readonly hostId: string };

// Like the composer's model selection: `null` means the user has not picked
// anything for the current draft and the default applies, while a value is the
// user's own choice — including an explicit "no computer at all".
const internalNewThreadComputerAccess$ = state<NewThreadComputerAccess | null>(
  null,
);

export const newThreadComputerAccess$ = computed(
  (get): NewThreadComputerAccess => {
    const selection = get(internalNewThreadComputerAccess$);
    const cloudBrowserAvailable = get(zeroBrowserEnabled$);
    if (selection === null) {
      // Cloud browser is the default surface wherever Zero Browser is on.
      return cloudBrowserAvailable
        ? { kind: "cloudBrowser" }
        : { kind: "none" };
    }
    return selection.kind === "cloudBrowser" && !cloudBrowserAvailable
      ? { kind: "none" }
      : selection;
  },
);

export const setNewThreadComputerUseHostId$ = command(
  ({ set }, hostId: string | null) => {
    set(
      internalNewThreadComputerAccess$,
      hostId === null ? { kind: "none" } : { kind: "computerUse", hostId },
    );
  },
);

export const setNewThreadCloudBrowserEnabled$ = command(
  ({ set }, enabled: boolean) => {
    set(
      internalNewThreadComputerAccess$,
      enabled ? { kind: "cloudBrowser" } : { kind: "none" },
    );
  },
);

// Sending starts the next draft from scratch, so the selection goes back to the
// default instead of pinning the sent thread's choice.
export const resetNewThreadComputerAccess$ = command(({ set }) => {
  set(internalNewThreadComputerAccess$, null);
});

// -- Model picker open state ------------------------------------------------

export interface TemplateCardHtmlPreviewState {
  readonly slug: string;
  readonly embedUrl: string;
  readonly themeId: string;
  readonly loading: boolean;
  readonly frameUrl: string | null;
  readonly slideCount: number;
}

interface TemplateCardHoverState {
  readonly slug: string;
  readonly index: number;
}

interface TemplateDetailHtmlPreviewState {
  readonly slug: string;
  readonly embedUrl: string;
  readonly themeId: string;
  readonly themeCss: string;
  readonly index: number;
  readonly loading: boolean;
  readonly frameLoaded: boolean;
  readonly frameUrl: string | null;
  readonly previousFrameSlideIndex: number | null;
  readonly previousFrameUrl: string | null;
  readonly slideCount: number;
}

interface PresentationTemplateDetailSelection {
  readonly embedUrl: string;
  readonly index: number;
  readonly slug: string;
  readonly themeCss: string;
  readonly themeId: string;
}

interface PresentationTemplateDetailSelectionParams {
  readonly index: number;
  readonly item: PresentationTemplateItem;
  readonly runtime: TemplatePreviewRuntime;
  readonly themeCss: string;
  readonly themeId: string;
}

interface LoadedTemplateDetailFrame {
  readonly slideIndex: number;
  readonly url: string;
}

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

function presentationTemplateDetailSlideCount(
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
    themeCss: params.selection.themeCss,
    index: params.selection.index,
    loading: false,
    frameLoaded: false,
    frameUrl,
    previousFrameSlideIndex: null,
    previousFrameUrl: null,
    slideCount: params.draft.slides.length,
  };
}

function previousTemplateDetailFrame(
  current: TemplateDetailHtmlPreviewState | null,
): LoadedTemplateDetailFrame | null {
  if (current?.frameLoaded && current.frameUrl !== null) {
    return { slideIndex: current.index, url: current.frameUrl };
  }
  if (
    current?.previousFrameUrl !== null &&
    current?.previousFrameUrl !== undefined &&
    current.previousFrameSlideIndex !== null
  ) {
    return {
      slideIndex: current.previousFrameSlideIndex,
      url: current.previousFrameUrl,
    };
  }
  return null;
}

function templateDetailFrameUrls(
  preview: TemplateDetailHtmlPreviewState | null,
): ReadonlySet<string> {
  const frameUrls = new Set<string>();
  if (preview?.frameUrl !== null && preview?.frameUrl !== undefined) {
    frameUrls.add(preview.frameUrl);
  }
  if (
    preview?.previousFrameUrl !== null &&
    preview?.previousFrameUrl !== undefined
  ) {
    frameUrls.add(preview.previousFrameUrl);
  }
  return frameUrls;
}

function revokeUnusedTemplateDetailFrameUrls(
  frameUrls: ReadonlySet<string>,
  retainedFrameUrls: ReadonlySet<string>,
): void {
  for (const frameUrl of frameUrls) {
    if (!retainedFrameUrls.has(frameUrl)) {
      URL.revokeObjectURL(frameUrl);
    }
  }
}

async function loadPresentationTemplateHtmlPreview(params: {
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

function createBasicComposerUiSignals() {
  const internalModelPickerOpen$ = state(false);
  const modelPickerOpen$ = computed((get) => {
    return get(internalModelPickerOpen$);
  });
  const setModelPickerOpen$ = command(({ set }, open: boolean) => {
    set(internalModelPickerOpen$, open);
  });

  const internalUploadPopoverOpen$ = state(false);
  const uploadPopoverOpen$ = computed((get) => {
    return get(internalUploadPopoverOpen$);
  });
  const setUploadPopoverOpen$ = command(({ set }, open: boolean) => {
    set(internalUploadPopoverOpen$, open);
  });

  return {
    modelPickerOpen$,
    setModelPickerOpen$,
    uploadPopoverOpen$,
    setUploadPopoverOpen$,
  };
}

function createTemplatePickerDialogSignals() {
  const internalWebsiteTemplatePreviewId$ = state<string | null>(null);
  const internalWebsiteTemplatePreviewLoaded$ = state(false);
  const internalTemplatePickerOpen$ = state(false);
  const internalTemplatePickerSkipEnterAnimation$ = state(false);
  const templatePickerOpen$ = computed((get) => {
    return (
      get(internalTemplatePickerOpen$) &&
      get(internalWebsiteTemplatePreviewId$) === null
    );
  });
  const templatePickerSkipEnterAnimation$ = computed((get) => {
    return get(internalTemplatePickerSkipEnterAnimation$);
  });
  const setTemplatePickerOpen$ = command(({ set }, open: boolean) => {
    set(internalTemplatePickerSkipEnterAnimation$, false);
    set(internalTemplatePickerOpen$, open);
  });

  const internalTemplatePickerReferenceValue$ =
    state<GenerationTemplateRequest | null>(null);
  const templatePickerReferenceValue$ = computed((get) => {
    return get(internalTemplatePickerReferenceValue$);
  });
  const setTemplatePickerReferenceValue$ = command(
    ({ set }, value: GenerationTemplateRequest | null) => {
      set(internalTemplatePickerReferenceValue$, value);
    },
  );

  const websiteTemplatePreviewId$ = computed((get) => {
    return get(internalWebsiteTemplatePreviewId$);
  });
  const websiteTemplatePreviewLoaded$ = computed((get) => {
    return get(internalWebsiteTemplatePreviewLoaded$);
  });
  const markWebsiteTemplatePreviewLoaded$ = command(({ set }) => {
    set(internalWebsiteTemplatePreviewLoaded$, true);
  });
  const openWebsiteTemplatePreview$ = command(({ set }, templateId: string) => {
    set(internalTemplatePickerSkipEnterAnimation$, false);
    set(internalWebsiteTemplatePreviewLoaded$, false);
    set(internalWebsiteTemplatePreviewId$, templateId);
  });
  const closeWebsiteTemplatePreview$ = command(({ set }) => {
    set(internalTemplatePickerSkipEnterAnimation$, true);
    set(internalWebsiteTemplatePreviewLoaded$, false);
    set(internalWebsiteTemplatePreviewId$, null);
  });

  return {
    templatePickerOpen$,
    templatePickerSkipEnterAnimation$,
    setTemplatePickerOpen$,
    templatePickerReferenceValue$,
    setTemplatePickerReferenceValue$,
    websiteTemplatePreviewId$,
    websiteTemplatePreviewLoaded$,
    markWebsiteTemplatePreviewLoaded$,
    openWebsiteTemplatePreview$,
    closeWebsiteTemplatePreview$,
  };
}

function createTemplatePickerListSignals() {
  const internalTemplatePickerCategory$ = state("slides");
  const templatePickerCategory$ = computed((get) => {
    return get(internalTemplatePickerCategory$);
  });
  const setTemplatePickerCategory$ = command(({ set }, category: string) => {
    set(internalTemplatePickerCategory$, category);
  });

  const internalTemplatePickerSearch$ = state("");
  const templatePickerSearch$ = computed((get) => {
    return get(internalTemplatePickerSearch$);
  });
  const setTemplatePickerSearch$ = command(({ set }, value: string) => {
    set(internalTemplatePickerSearch$, value);
  });

  // Selected persona pill in the workflow template tab ("all" or a category from
  // WORKFLOW_TEMPLATE_CATEGORIES). Mirrors the ideation gallery's pill filter.
  const internalTemplatePickerWorkflowCategory$ = state("all");
  const templatePickerWorkflowCategory$ = computed((get) => {
    return get(internalTemplatePickerWorkflowCategory$);
  });
  const setTemplatePickerWorkflowCategory$ = command(
    ({ set }, category: string) => {
      set(internalTemplatePickerWorkflowCategory$, category);
    },
  );

  const internalTemplatePickerPreviewSlug$ = state<string | null>(null);
  const templatePickerPreviewSlug$ = computed((get) => {
    return get(internalTemplatePickerPreviewSlug$);
  });
  const setTemplatePickerPreviewSlug$ = command(
    ({ set }, slug: string | null) => {
      set(internalTemplatePickerPreviewSlug$, slug);
    },
  );

  const internalTemplatePickerPresentationScrollTop$ = state(0);
  const setTemplatePickerPresentationScrollTop$ = command(
    ({ set }, scrollTop: number) => {
      set(internalTemplatePickerPresentationScrollTop$, scrollTop);
    },
  );
  const restoreTemplatePickerPresentationScroll$ = command(
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
  const illustrationVariantIndex$ = computed((get) => {
    return get(internalIllustrationVariantIndex$);
  });
  const setIllustrationVariantIndex$ = command(
    ({ get, set }, slug: string, index: number) => {
      set(internalIllustrationVariantIndex$, {
        ...get(internalIllustrationVariantIndex$),
        [slug]: index,
      });
    },
  );

  return {
    signals: {
      templatePickerCategory$,
      setTemplatePickerCategory$,
      templatePickerSearch$,
      setTemplatePickerSearch$,
      templatePickerWorkflowCategory$,
      setTemplatePickerWorkflowCategory$,
      templatePickerPreviewSlug$,
      setTemplatePickerPreviewSlug$,
      setTemplatePickerPresentationScrollTop$,
      restoreTemplatePickerPresentationScroll$,
      illustrationVariantIndex$,
      setIllustrationVariantIndex$,
    },
    internalTemplatePickerPreviewSlug$,
  };
}

function createTemplateCardSignals() {
  const internalTemplateCardHover$ = state<TemplateCardHoverState | null>(null);
  const templateCardHover$ = computed((get) => {
    return get(internalTemplateCardHover$);
  });
  const setTemplateCardHover$ = command(
    ({ set }, value: TemplateCardHoverState | null) => {
      set(internalTemplateCardHover$, value);
    },
  );

  const internalTemplateCardHtmlPreview$ =
    state<TemplateCardHtmlPreviewState | null>(null);
  const templateCardHtmlPreview$ = computed((get) => {
    return get(internalTemplateCardHtmlPreview$);
  });
  const setTemplateCardHtmlPreview$ = command(
    ({ set }, value: TemplateCardHtmlPreviewState | null) => {
      set(internalTemplateCardHtmlPreview$, value);
    },
  );

  const internalTemplateCardLoadedHtmlFrameUrls$ = state<
    Readonly<Record<string, string>>
  >({});
  const templateCardLoadedHtmlFrameUrls$ = computed((get) => {
    return get(internalTemplateCardLoadedHtmlFrameUrls$);
  });
  const setTemplateCardLoadedHtmlFrameUrl$ = command(
    ({ get, set }, key: string, frameUrl: string) => {
      set(internalTemplateCardLoadedHtmlFrameUrls$, {
        ...get(internalTemplateCardLoadedHtmlFrameUrls$),
        [key]: frameUrl,
      });
    },
  );

  const clearTemplateCardHtmlPreviewFrames$ = command(({ get, set }) => {
    const activeFrameUrl = get(internalTemplateCardHtmlPreview$)?.frameUrl;
    const frameUrls = new Set(
      Object.values(get(internalTemplateCardLoadedHtmlFrameUrls$)),
    );
    if (activeFrameUrl !== null && activeFrameUrl !== undefined) {
      frameUrls.add(activeFrameUrl);
    }
    for (const frameUrl of frameUrls) {
      URL.revokeObjectURL(frameUrl);
    }
    set(internalTemplateCardHtmlPreview$, null);
    set(internalTemplateCardLoadedHtmlFrameUrls$, {});
  });

  const internalTemplateCardThemeIdBySlug$ = state<
    Readonly<Record<string, string>>
  >({});
  const {
    get$: templateCardThemeIdBySlugRaw$,
    set$: setTemplateCardThemeIdBySlugRaw$,
  } = localStorageSignals("presentationTemplateThemeIdBySlug");
  const templateCardThemeIdBySlug$ = computed((get) => {
    return {
      ...parseTemplateCardThemeIdBySlug(get(templateCardThemeIdBySlugRaw$)),
      ...get(internalTemplateCardThemeIdBySlug$),
    };
  });
  const setTemplateCardThemeId$ = command(
    ({ get, set }, slug: string, themeId: string) => {
      const next = {
        ...get(templateCardThemeIdBySlug$),
        [slug]: themeId,
      };
      set(internalTemplateCardThemeIdBySlug$, next);
      set(setTemplateCardThemeIdBySlugRaw$, JSON.stringify(next));
    },
  );

  return {
    signals: {
      templateCardHover$,
      setTemplateCardHover$,
      templateCardHtmlPreview$,
      setTemplateCardHtmlPreview$,
      templateCardLoadedHtmlFrameUrls$,
      setTemplateCardLoadedHtmlFrameUrl$,
      templateCardThemeIdBySlug$,
      setTemplateCardThemeId$,
    },
    internalTemplateCardHover$,
    clearTemplateCardHtmlPreviewFrames$,
  };
}

function createTemplateDetailStateSignals() {
  const internalTemplateDetailHtmlPreview$ =
    state<TemplateDetailHtmlPreviewState | null>(null);
  const templateDetailHtmlPreview$ = computed((get) => {
    return get(internalTemplateDetailHtmlPreview$);
  });
  const replaceTemplateDetailHtmlPreview$ = command(
    ({ get, set }, value: TemplateDetailHtmlPreviewState | null) => {
      const current = get(internalTemplateDetailHtmlPreview$);
      if (value === null) {
        revokeUnusedTemplateDetailFrameUrls(
          templateDetailFrameUrls(current),
          new Set(),
        );
        set(internalTemplateDetailHtmlPreview$, null);
        return;
      }

      const previousFrame = previousTemplateDetailFrame(current);
      const retainedFrameUrls = new Set<string>();
      if (value.frameUrl !== null) {
        retainedFrameUrls.add(value.frameUrl);
      }
      if (previousFrame !== null) {
        retainedFrameUrls.add(previousFrame.url);
      }
      revokeUnusedTemplateDetailFrameUrls(
        templateDetailFrameUrls(current),
        retainedFrameUrls,
      );
      set(internalTemplateDetailHtmlPreview$, {
        ...value,
        previousFrameSlideIndex: previousFrame?.slideIndex ?? null,
        previousFrameUrl: previousFrame?.url ?? null,
      });
    },
  );

  const settlePresentationTemplateDetailPreviewFrame$ = command(
    ({ get, set }, frameUrl: string): void => {
      const current = get(internalTemplateDetailHtmlPreview$);
      if (current?.frameUrl !== frameUrl) {
        return;
      }
      if (current.previousFrameUrl !== null) {
        URL.revokeObjectURL(current.previousFrameUrl);
      }
      set(internalTemplateDetailHtmlPreview$, {
        ...current,
        frameLoaded: true,
        previousFrameSlideIndex: null,
        previousFrameUrl: null,
      });
    },
  );

  return {
    signals: {
      templateDetailHtmlPreview$,
      settlePresentationTemplateDetailPreviewFrame$,
    },
    internalTemplateDetailHtmlPreview$,
    replaceTemplateDetailHtmlPreview$,
  };
}

function createTemplatePreviewResourceSignals(
  list: ReturnType<typeof createTemplatePickerListSignals>,
  cards: ReturnType<typeof createTemplateCardSignals>,
  detail: ReturnType<typeof createTemplateDetailStateSignals>,
) {
  const releaseTemplatePickerPreviewResources$ = command(
    ({ set }, runtime: TemplatePreviewRuntime) => {
      const preview = runtime.presentation;
      preview.detailRequestToken = null;
      for (const animationFrame of preview.pendingSlideAnimationFrames.values()) {
        window.cancelAnimationFrame(animationFrame);
      }
      preview.pendingSlideAnimationFrames.clear();
      preview.pendingSlideIndexes.clear();
      preview.activeIndexes.clear();
      preview.activeTokens.clear();
      set(cards.clearTemplateCardHtmlPreviewFrames$);
      set(cards.internalTemplateCardHover$, null);
      set(detail.replaceTemplateDetailHtmlPreview$, null);
      set(list.internalTemplatePickerPreviewSlug$, null);
    },
  );

  const ownTemplatePickerPreviewResources$ = command(
    ({ set }, runtime: TemplatePreviewRuntime, signal: AbortSignal): void => {
      const preview = runtime.presentation;
      if (preview.previewOwnerSignal === signal) {
        return;
      }
      preview.previewOwnerSignal = signal;
      signal.addEventListener(
        "abort",
        () => {
          if (preview.previewOwnerSignal !== signal) {
            return;
          }
          preview.previewOwnerSignal = null;
          set(releaseTemplatePickerPreviewResources$, runtime);
        },
        { once: true },
      );
    },
  );

  return {
    releaseTemplatePickerPreviewResources$,
    ownTemplatePickerPreviewResources$,
  };
}

function createApplyPresentationTemplateDetailSelectionSignal(
  detail: ReturnType<typeof createTemplateDetailStateSignals>,
) {
  return command(
    (
      { set },
      runtime: TemplatePreviewRuntime,
      item: PresentationTemplateItem,
      selection: PresentationTemplateDetailSelection,
    ) => {
      const draft = runtime.presentation.drafts.get(item.embedUrl);
      if (draft !== undefined) {
        set(
          detail.replaceTemplateDetailHtmlPreview$,
          presentationTemplateDetailPreviewState({
            draft,
            item,
            selection,
          }),
        );
        return;
      }

      const failed = runtime.presentation.failed.has(item.embedUrl);
      set(detail.replaceTemplateDetailHtmlPreview$, {
        slug: item.slug,
        embedUrl: item.embedUrl,
        themeId: selection.themeId,
        themeCss: selection.themeCss,
        index: selection.index,
        loading: !failed,
        frameLoaded: false,
        frameUrl: null,
        previousFrameSlideIndex: null,
        previousFrameUrl: null,
        slideCount: presentationTemplateDetailSlideCount(item),
      });
    },
  );
}

function createOpenPresentationTemplateDetailPreviewSignal(
  list: ReturnType<typeof createTemplatePickerListSignals>,
  detail: ReturnType<typeof createTemplateDetailStateSignals>,
  resources: ReturnType<typeof createTemplatePreviewResourceSignals>,
  applySelection$: ReturnType<
    typeof createApplyPresentationTemplateDetailSelectionSignal
  >,
) {
  return command(
    async (
      { get, set },
      params: PresentationTemplateDetailSelectionParams,
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      const cache = params.runtime.presentation;
      set(resources.ownTemplatePickerPreviewResources$, params.runtime, signal);
      const token = Symbol(params.item.embedUrl);
      const selection: PresentationTemplateDetailSelection = {
        embedUrl: params.item.embedUrl,
        index: params.index,
        slug: params.item.slug,
        themeCss: params.themeCss,
        themeId: params.themeId,
      };
      cache.detailRequestToken = token;
      set(applySelection$, params.runtime, params.item, selection);
      set(list.internalTemplatePickerPreviewSlug$, params.item.slug);

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

      if (cache.detailRequestToken !== token) {
        return;
      }
      const activeDetail = get(detail.internalTemplateDetailHtmlPreview$);
      if (
        activeDetail === null ||
        activeDetail.embedUrl !== params.item.embedUrl ||
        activeDetail.slug !== params.item.slug
      ) {
        return;
      }
      set(applySelection$, params.runtime, params.item, {
        embedUrl: activeDetail.embedUrl,
        index: activeDetail.index,
        slug: activeDetail.slug,
        themeCss: activeDetail.themeCss,
        themeId: activeDetail.themeId,
      });
    },
  );
}

function createPresentationTemplateDetailNavigationSignals(
  list: ReturnType<typeof createTemplatePickerListSignals>,
  detail: ReturnType<typeof createTemplateDetailStateSignals>,
  applySelection$: ReturnType<
    typeof createApplyPresentationTemplateDetailSelectionSignal
  >,
) {
  const selectPresentationTemplateDetailPreview$ = command(
    ({ get, set }, params: PresentationTemplateDetailSelectionParams) => {
      const activeDetail = get(detail.internalTemplateDetailHtmlPreview$);
      if (
        activeDetail === null ||
        activeDetail.embedUrl !== params.item.embedUrl ||
        activeDetail.slug !== params.item.slug
      ) {
        return;
      }
      set(applySelection$, params.runtime, params.item, {
        embedUrl: params.item.embedUrl,
        index: params.index,
        slug: params.item.slug,
        themeCss: params.themeCss,
        themeId: params.themeId,
      });
    },
  );

  const closePresentationTemplateDetailPreview$ = command(
    ({ set }, runtime: TemplatePreviewRuntime) => {
      runtime.presentation.detailRequestToken = null;
      set(detail.replaceTemplateDetailHtmlPreview$, null);
      set(list.internalTemplatePickerPreviewSlug$, null);
    },
  );

  return {
    selectPresentationTemplateDetailPreview$,
    closePresentationTemplateDetailPreview$,
  };
}

export function createComposerUiSignals() {
  const list = createTemplatePickerListSignals();
  const cards = createTemplateCardSignals();
  const detail = createTemplateDetailStateSignals();
  const resources = createTemplatePreviewResourceSignals(list, cards, detail);
  const applySelection$ =
    createApplyPresentationTemplateDetailSelectionSignal(detail);
  const openPresentationTemplateDetailPreview$ =
    createOpenPresentationTemplateDetailPreviewSignal(
      list,
      detail,
      resources,
      applySelection$,
    );

  return {
    ...createBasicComposerUiSignals(),
    ...createTemplatePickerDialogSignals(),
    ...list.signals,
    ...cards.signals,
    ...detail.signals,
    ...resources,
    loadPresentationTemplateHtmlPreview,
    openPresentationTemplateDetailPreview$,
    ...createPresentationTemplateDetailNavigationSignals(
      list,
      detail,
      applySelection$,
    ),
  };
}

export type ComposerUiSignals = ReturnType<typeof createComposerUiSignals>;

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
