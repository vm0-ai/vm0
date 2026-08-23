import { command, computed, state } from "ccstate";
import {
  presentationTemplatesContract,
  type PresentationTemplateDetail,
  type PresentationTemplateSummary,
  type UpdatePresentationTemplateBody,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { presentationTemplateImportEnabled$ } from "./presentation-template-import.ts";

export type { PresentationTemplateDetail, PresentationTemplateSummary };

const presentationTemplatesVersion$ = state(0);

/**
 * The decks this workspace member can use. Their own decks come first, then
 * decks other members made visible to the workspace.
 *
 * Answering with an empty catalog while the switch is off is not a fallback for
 * a failed request: the route replies `403` to a caller without the switch, and
 * `accept` would surface that as an error toast on a dialog the user opened to
 * browse built-in templates.
 */
/**
 * Refetch the catalog after a mutation or after the picker closes. Refreshing
 * while the picker is hidden lets page-level consumers prewarm replacement
 * signed cover URLs without swapping images in the visible dialog.
 */
export const refreshPresentationTemplates$ = command(({ get, set }) => {
  set(presentationTemplatesVersion$, get(presentationTemplatesVersion$) + 1);
});

const refreshPresentationTemplatesFromRealtime$ = command(({ set }) => {
  set(refreshPresentationTemplates$);
  return false;
});

/**
 * A template is published by the analysis runner, outside any composer or
 * browser mutation. Subscribe once at the authenticated workspace boundary so
 * navigation cannot strand a newly published deck in the thread that started
 * the analysis.
 */
export const subscribePresentationTemplatesChanged$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(
      setAblyLoop$,
      {
        topic: "presentationTemplatesChanged",
        loopCommand$: refreshPresentationTemplatesFromRealtime$,
      },
      signal,
    );
  },
);

function createImportedPresentationTemplates$() {
  return computed(
    async (get): Promise<readonly PresentationTemplateSummary[]> => {
      if (!get(presentationTemplateImportEnabled$)) {
        return [];
      }
      get(presentationTemplatesVersion$);
      const client = get(apiClient$)(presentationTemplatesContract);
      const result = await accept(client.list(), [200]);
      return result.body;
    },
  );
}

interface ImportedPresentationTemplateHover {
  readonly templateId: string;
  readonly index: number;
}

function createImportedPresentationTemplateHoverSignals() {
  const internalCardHover$ = state<ImportedPresentationTemplateHover | null>(
    null,
  );
  const importedPresentationTemplateCardHover$ = computed((get) => {
    return get(internalCardHover$);
  });
  const setImportedPresentationTemplateCardHover$ = command(
    ({ set }, hover: ImportedPresentationTemplateHover | null) => {
      set(internalCardHover$, hover);
    },
  );
  return {
    internalCardHover$,
    importedPresentationTemplateCardHover$,
    setImportedPresentationTemplateCardHover$,
  };
}

/** Dialog-scoped state and mutations for persisted uploaded templates. */
export function createImportedPresentationTemplateSignals() {
  const importedPresentationTemplates$ = createImportedPresentationTemplates$();
  const internalRequestedTemplateId$ = state<string | null>(null);
  const internalDetailVersion$ = state(0);
  const importedPresentationTemplateRequestedId$ = computed((get) => {
    return get(internalRequestedTemplateId$);
  });
  const importedPresentationTemplateDetail$ = computed(
    async (get): Promise<PresentationTemplateDetail | null> => {
      const templateId = get(internalRequestedTemplateId$);
      get(internalDetailVersion$);
      if (templateId === null) {
        return null;
      }
      const client = get(apiClient$)(presentationTemplatesContract);
      const result = await accept(
        client.get({ params: { templateId } }),
        [200],
      );
      return result.body;
    },
  );
  const requestImportedPresentationTemplateDetail$ = command(
    ({ set }, templateId: string) => {
      set(internalRequestedTemplateId$, templateId);
    },
  );

  const internalPreviewTemplateId$ = state<string | null>(null);
  const importedPresentationTemplatePreviewId$ = computed((get) => {
    return get(internalPreviewTemplateId$);
  });
  const internalPreviewSlideIndex$ = state(0);
  const importedPresentationTemplatePreviewSlideIndex$ = computed((get) => {
    return get(internalPreviewSlideIndex$);
  });
  const openImportedPresentationTemplatePreview$ = command(
    ({ set }, templateId: string, index: number) => {
      set(internalRequestedTemplateId$, templateId);
      set(internalPreviewTemplateId$, templateId);
      set(internalPreviewSlideIndex$, index);
    },
  );
  const closeImportedPresentationTemplatePreview$ = command(({ set }) => {
    set(internalPreviewTemplateId$, null);
    set(internalPreviewSlideIndex$, 0);
  });
  const selectImportedPresentationTemplatePreviewSlide$ = command(
    ({ set }, index: number) => {
      set(internalPreviewSlideIndex$, index);
    },
  );

  const {
    internalCardHover$,
    importedPresentationTemplateCardHover$,
    setImportedPresentationTemplateCardHover$,
  } = createImportedPresentationTemplateHoverSignals();

  const updateImportedPresentationTemplate$ = command(
    async (
      { get, set },
      templateId: string,
      body: UpdatePresentationTemplateBody,
      signal: AbortSignal,
    ): Promise<void> => {
      const client = get(apiClient$)(presentationTemplatesContract);
      await accept(
        client.update({
          params: { templateId },
          body,
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
      set(internalDetailVersion$, (version) => {
        return version + 1;
      });
      set(refreshPresentationTemplates$);
    },
  );

  const deleteImportedPresentationTemplate$ = command(
    async (
      { get, set },
      templateId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const client = get(apiClient$)(presentationTemplatesContract);
      await accept(
        client.delete({
          params: { templateId },
          fetchOptions: { signal },
        }),
        [204],
      );
      signal.throwIfAborted();
      set(internalPreviewTemplateId$, null);
      set(internalPreviewSlideIndex$, 0);
      set(internalRequestedTemplateId$, null);
      set(internalCardHover$, null);
      set(refreshPresentationTemplates$);
    },
  );

  const resetImportedPresentationTemplatePicker$ = command(({ set }) => {
    set(internalPreviewTemplateId$, null);
    set(internalPreviewSlideIndex$, 0);
    set(internalRequestedTemplateId$, null);
    set(internalCardHover$, null);
  });

  return {
    importedPresentationTemplates$,
    importedPresentationTemplateRequestedId$,
    importedPresentationTemplateDetail$,
    requestImportedPresentationTemplateDetail$,
    importedPresentationTemplatePreviewId$,
    importedPresentationTemplatePreviewSlideIndex$,
    openImportedPresentationTemplatePreview$,
    closeImportedPresentationTemplatePreview$,
    selectImportedPresentationTemplatePreviewSlide$,
    importedPresentationTemplateCardHover$,
    setImportedPresentationTemplateCardHover$,
    updateImportedPresentationTemplate$,
    deleteImportedPresentationTemplate$,
    resetImportedPresentationTemplatePicker$,
  };
}
