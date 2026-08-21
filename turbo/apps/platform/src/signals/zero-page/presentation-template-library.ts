import { command, computed, state } from "ccstate";
import {
  presentationTemplatesContract,
  type PresentationTemplateDetail,
  type PresentationTemplateSummary,
  type UpdatePresentationTemplateBody,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
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
export const presentationTemplates$ = computed(
  async (get): Promise<readonly PresentationTemplateSummary[]> => {
    if (!get(presentationTemplateImportEnabled$)) {
      return [];
    }
    get(presentationTemplatesVersion$);
    const client = get(zeroClient$)(presentationTemplatesContract);
    const result = await accept(client.list(), [200]);
    return result.body;
  },
);

/**
 * Refetch the catalog.
 *
 * The picker calls this as it opens rather than reading a session-long cache,
 * because both facts it renders go stale on their own: an import finishes
 * minutes after the deck was handed over, in a thread the user navigates away
 * from, and every cover URL is a short-lived signed URL.
 */
export const refreshPresentationTemplates$ = command(({ get, set }) => {
  set(presentationTemplatesVersion$, get(presentationTemplatesVersion$) + 1);
});

interface ImportedPresentationTemplateHover {
  readonly templateId: string;
  readonly index: number;
}

/** Dialog-scoped state and mutations for persisted uploaded templates. */
export function createImportedPresentationTemplateSignals() {
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
      const client = get(zeroClient$)(presentationTemplatesContract);
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

  const updateImportedPresentationTemplate$ = command(
    async (
      { get, set },
      templateId: string,
      body: UpdatePresentationTemplateBody,
      signal: AbortSignal,
    ): Promise<void> => {
      const client = get(zeroClient$)(presentationTemplatesContract);
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
      const client = get(zeroClient$)(presentationTemplatesContract);
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
