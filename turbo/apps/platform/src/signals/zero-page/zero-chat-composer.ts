import { command, computed, state } from "ccstate";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import type { VideoStyleCategory } from "@vm0/core";

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

const internalPendingConnectType$ = state<string | null>(null);
export const pendingConnectType$ = computed((get) => {
  return get(internalPendingConnectType$);
});
export const setPendingConnectType$ = command(
  ({ set }, type: string | null) => {
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

// -- Slash skill picker -----------------------------------------------------

const internalSlashSkillCaretIndex$ = state(0);
export const slashSkillCaretIndex$ = computed((get) => {
  return get(internalSlashSkillCaretIndex$);
});
export const setSlashSkillCaretIndex$ = command(
  ({ set }, caretIndex: number) => {
    set(internalSlashSkillCaretIndex$, caretIndex);
  },
);

const internalSelectedSlashSkillIndex$ = state(0);
export const selectedSlashSkillIndex$ = computed((get) => {
  return get(internalSelectedSlashSkillIndex$);
});
export const setSelectedSlashSkillIndex$ = command(({ set }, index: number) => {
  set(internalSelectedSlashSkillIndex$, index);
});

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

const internalPopoverSortOrder$ = state<string[] | null>(null);
export const popoverSortOrder$ = computed((get) => {
  return get(internalPopoverSortOrder$);
});
export const setPopoverSortOrder$ = command(
  ({ set }, order: string[] | null) => {
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

// -- Computer Use popover open state ----------------------------------------

const internalComputerUsePopoverOpen$ = state(false);
const internalComputerUsePopoverIgnoreClose$ = state(false);

export const computerUsePopoverOpen$ = computed((get) => {
  return get(internalComputerUsePopoverOpen$);
});

export const setComputerUsePopoverOpen$ = command(
  ({ get, set }, open: boolean) => {
    if (open) {
      set(internalComputerUsePopoverOpen$, true);
      set(internalComputerUsePopoverIgnoreClose$, true);
      return;
    }

    if (get(internalComputerUsePopoverIgnoreClose$)) {
      set(internalComputerUsePopoverIgnoreClose$, false);
      return;
    }

    set(internalComputerUsePopoverOpen$, false);
  },
);

export const clearComputerUsePopoverCloseSuppression$ = command(({ set }) => {
  set(internalComputerUsePopoverIgnoreClose$, false);
});

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

export type TemplatePickerVideoGroup = VideoStyleCategory | "all";

const internalTemplatePickerVideoGroup$ =
  state<TemplatePickerVideoGroup>("all");
export const templatePickerVideoGroup$ = computed((get) => {
  return get(internalTemplatePickerVideoGroup$);
});
export const setTemplatePickerVideoGroup$ = command(
  ({ set }, value: TemplatePickerVideoGroup) => {
    set(internalTemplatePickerVideoGroup$, value);
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

const internalTemplatePickerPreviewSlideIndex$ = state(0);
export const templatePickerPreviewSlideIndex$ = computed((get) => {
  return get(internalTemplatePickerPreviewSlideIndex$);
});
export const setTemplatePickerPreviewSlideIndex$ = command(
  ({ set }, index: number) => {
    set(internalTemplatePickerPreviewSlideIndex$, index);
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
