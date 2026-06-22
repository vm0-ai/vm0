import { command, computed, state } from "ccstate";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import type { ConnectorType } from "@vm0/connectors/connectors";

// ---------------------------------------------------------------------------
// Composer UI state — search, dialogs, loading indicators
// ---------------------------------------------------------------------------

// -- Add-connectors dialog --------------------------------------------------

const internalShowAddDialog$ = state(false);
export const showAddDialog$ = computed((get) => {
  return get(internalShowAddDialog$);
});
export const setShowAddDialog$ = command(({ set }, open: boolean) => {
  set(internalShowAddDialog$, open);
});

// -- Pending OAuth connection type ------------------------------------------

const internalPendingConnectType$ = state<ConnectorType | null>(null);
export const pendingConnectType$ = computed((get) => {
  return get(internalPendingConnectType$);
});
export const setPendingConnectType$ = command(
  ({ set }, type: ConnectorType | null) => {
    set(internalPendingConnectType$, type);
  },
);

// -- Connector toggle saving indicator --------------------------------------

const internalComposerSavingType$ = state<string | null>(null);
export const composerSavingType$ = computed((get) => {
  return get(internalComposerSavingType$);
});
export const setComposerSavingType$ = command(
  ({ set }, type: string | null) => {
    set(internalComposerSavingType$, type);
  },
);

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

const internalSelectedSlashWorkflowIndex$ = state(0);
export const selectedSlashWorkflowIndex$ = computed((get) => {
  return get(internalSelectedSlashWorkflowIndex$);
});
export const setSelectedSlashWorkflowIndex$ = command(
  ({ set }, index: number) => {
    set(internalSelectedSlashWorkflowIndex$, index);
  },
);

// -- Add-connectors dialog search filter ------------------------------------

const internalAddDialogSearch$ = state("");
export const addDialogSearch$ = computed((get) => {
  return get(internalAddDialogSearch$);
});
export const setAddDialogSearch$ = command(({ set }, value: string) => {
  set(internalAddDialogSearch$, value);
});

// -- Connector popover search filter ----------------------------------------

const internalPopoverSearch$ = state("");
export const popoverSearch$ = computed((get) => {
  return get(internalPopoverSearch$);
});
export const setPopoverSearch$ = command(({ set }, value: string) => {
  set(internalPopoverSearch$, value);
});

// -- Connector popover sort order snapshot ----------------------------------

const internalPopoverSortOrder$ = state<ConnectorType[] | null>(null);
export const popoverSortOrder$ = computed((get) => {
  return get(internalPopoverSortOrder$);
});
export const setPopoverSortOrder$ = command(
  ({ set }, order: ConnectorType[] | null) => {
    set(internalPopoverSortOrder$, order);
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

const internalComputerUseDownloadDialogOpen$ = state(false);
export const computerUseDownloadDialogOpen$ = computed((get) => {
  return get(internalComputerUseDownloadDialogOpen$);
});
export const setComputerUseDownloadDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalComputerUseDownloadDialogOpen$, open);
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

const internalTemplatePickerPreviewSlug$ = state<string | null>(null);
export const templatePickerPreviewSlug$ = computed((get) => {
  return get(internalTemplatePickerPreviewSlug$);
});
export const setTemplatePickerPreviewSlug$ = command(
  ({ set }, slug: string | null) => {
    set(internalTemplatePickerPreviewSlug$, slug);
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

const internalTemplateCardFailedImageUrls$ = state<
  Readonly<Record<string, true>>
>({});
export const templateCardFailedImageUrls$ = computed((get) => {
  return get(internalTemplateCardFailedImageUrls$);
});
export const setTemplateCardFailedImageUrl$ = command(
  ({ get, set }, url: string) => {
    const current = get(internalTemplateCardFailedImageUrls$);
    if (current[url] === true) {
      return;
    }
    set(internalTemplateCardFailedImageUrls$, {
      ...current,
      [url]: true,
    });
  },
);

export interface TemplateCardHtmlPreviewState {
  readonly slug: string;
  readonly embedUrl: string;
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

interface ThreadGenerationTemplateState {
  readonly threadId: string;
  readonly value: GenerationTemplateRequest | undefined;
}

const internalThreadGenerationTemplate$ =
  state<ThreadGenerationTemplateState | null>(null);
export const threadGenerationTemplate$ = computed((get) => {
  return get(internalThreadGenerationTemplate$);
});
export const setThreadGenerationTemplate$ = command(
  ({ set }, threadId: string, value: GenerationTemplateRequest | undefined) => {
    set(internalThreadGenerationTemplate$, { threadId, value });
  },
);
