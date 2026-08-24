import { command, computed, state, type Computed, type State } from "ccstate";
import { delay } from "signal-timers";
import {
  presentationTemplatesContract,
  PRESENTATION_TEMPLATE_URL_TTL_SECONDS,
  type PresentationTemplateDetail,
  type PresentationTemplateSummary,
  type UpdatePresentationTemplateBody,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { onRef, setLoop } from "../utils.ts";
import { presentationTemplateImportEnabled$ } from "./presentation-template-import.ts";

export type { PresentationTemplateDetail, PresentationTemplateSummary };

export interface ImportedPresentationTemplateResource {
  readonly summary: PresentationTemplateSummary;
  readonly detail$: Computed<Promise<PresentationTemplateDetail | null>>;
}

const presentationTemplatesVersion$ = state(0);
const PRESENTATION_TEMPLATE_URL_REFRESH_AGE_MS =
  (PRESENTATION_TEMPLATE_URL_TTL_SECONDS * 1000 * 2) / 3;

interface ImportedPresentationTemplateCatalog {
  readonly templates: readonly PresentationTemplateSummary[];
  readonly loadedAtMs: number;
}

/**
 * The decks this workspace member can use. Their own decks come first, then
 * decks other members made visible to the workspace.
 *
 * Answering with an empty catalog while the switch is off is not a fallback for
 * a failed request: the route replies `403` to a caller without the switch, and
 * `accept` would surface that as an error toast on a dialog the user opened to
 * browse built-in templates.
 */
/** Refetch the catalog after a mutation or realtime catch-up. */
const refreshPresentationTemplates$ = command(({ get, set }) => {
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
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);

function createImportedPresentationTemplateCatalog$() {
  return computed(async (get): Promise<ImportedPresentationTemplateCatalog> => {
    if (!get(presentationTemplateImportEnabled$)) {
      return { templates: [], loadedAtMs: now() };
    }
    get(presentationTemplatesVersion$);
    const client = get(apiClient$)(presentationTemplatesContract);
    const result = await accept(client.list(), [200]);
    return { templates: result.body, loadedAtMs: now() };
  });
}

function createImportedPresentationTemplates$(
  catalog$: Computed<Promise<ImportedPresentationTemplateCatalog>>,
) {
  return computed(
    async (get): Promise<readonly PresentationTemplateSummary[]> => {
      return (await get(catalog$)).templates;
    },
  );
}

function createImportedPresentationTemplateResources$(
  importedPresentationTemplates$: Computed<
    Promise<readonly PresentationTemplateSummary[]>
  >,
  internalDetailVersion$: State<number>,
) {
  return computed(
    async (get): Promise<readonly ImportedPresentationTemplateResource[]> => {
      const templates = await get(importedPresentationTemplates$);
      return templates.map((summary) => {
        return {
          summary,
          detail$: computed(
            async (get): Promise<PresentationTemplateDetail | null> => {
              get(internalDetailVersion$);
              const client = get(apiClient$)(presentationTemplatesContract);
              const result = await accept(
                client.get({ params: { templateId: summary.id } }),
                [200, 404],
              );
              return result.status === 404 ? null : result.body;
            },
          ),
        };
      });
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

function createImportedPresentationTemplateUrlRefreshSignals(
  catalog$: Computed<Promise<ImportedPresentationTemplateCatalog>>,
) {
  const internalRequestedAtMs$ = state<number | null>(null);
  const freshAtMs = (loadedAtMs: number, requestedAtMs: number | null) => {
    return Math.max(loadedAtMs, requestedAtMs ?? Number.NEGATIVE_INFINITY);
  };
  const refreshImportedPresentationTemplateUrlsIfStale$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const catalog = await get(catalog$);
      signal.throwIfAborted();
      const requestedAt = now();
      if (
        requestedAt -
          freshAtMs(catalog.loadedAtMs, get(internalRequestedAtMs$)) <
        PRESENTATION_TEMPLATE_URL_REFRESH_AGE_MS
      ) {
        return;
      }
      set(internalRequestedAtMs$, requestedAt);
      set(refreshPresentationTemplates$);
    },
  );
  const refreshImportedPresentationTemplateUrlsAfterPickerOpen$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      // Let the picker mount the last resolved catalog before catch-up makes
      // the catalog pending, so a suspended tab still opens without a blank
      // first frame.
      await delay(0, { signal });
      await set(refreshImportedPresentationTemplateUrlsIfStale$, signal);
    },
  );
  const importedPresentationTemplateUrlRefreshLifecycleRef$ = onRef(
    command(
      async (
        { get, set },
        _element: HTMLSpanElement,
        signal: AbortSignal,
      ): Promise<void> => {
        await setLoop(
          async (loopSignal) => {
            const catalog = await get(catalog$);
            loopSignal.throwIfAborted();
            const loadedOrRequestedAtMs = freshAtMs(
              catalog.loadedAtMs,
              get(internalRequestedAtMs$),
            );
            await delay(
              Math.max(
                0,
                PRESENTATION_TEMPLATE_URL_REFRESH_AGE_MS -
                  (now() - loadedOrRequestedAtMs),
              ),
              { signal: loopSignal },
            );
            await set(
              refreshImportedPresentationTemplateUrlsIfStale$,
              loopSignal,
            );
            return false;
          },
          0,
          signal,
          { retryTransientErrors: false },
        );
      },
    ),
  );
  return {
    refreshImportedPresentationTemplateUrlsAfterPickerOpen$,
    importedPresentationTemplateUrlRefreshLifecycleRef$,
  };
}

function createImportedPresentationTemplateDetailSignals(
  resources$: Computed<
    Promise<readonly ImportedPresentationTemplateResource[]>
  >,
) {
  const internalRequestedTemplateId$ = state<string | null>(null);
  const importedPresentationTemplateRequestedId$ = computed((get) => {
    return get(internalRequestedTemplateId$);
  });
  const importedPresentationTemplateDetail$ = computed(
    async (get): Promise<PresentationTemplateDetail | null> => {
      const templateId = get(internalRequestedTemplateId$);
      if (templateId === null) {
        return null;
      }
      const resources = await get(resources$);
      const resource = resources.find((candidate) => {
        return candidate.summary.id === templateId;
      });
      return resource === undefined ? null : await get(resource.detail$);
    },
  );
  const requestImportedPresentationTemplateDetail$ = command(
    ({ set }, templateId: string) => {
      set(internalRequestedTemplateId$, templateId);
    },
  );
  return {
    internalRequestedTemplateId$,
    importedPresentationTemplateRequestedId$,
    importedPresentationTemplateDetail$,
    requestImportedPresentationTemplateDetail$,
  };
}

/** Dialog-scoped state and mutations for persisted uploaded templates. */
export function createImportedPresentationTemplateSignals() {
  const catalog$ = createImportedPresentationTemplateCatalog$();
  const importedPresentationTemplates$ =
    createImportedPresentationTemplates$(catalog$);
  const internalDetailVersion$ = state(0);
  const urlRefresh =
    createImportedPresentationTemplateUrlRefreshSignals(catalog$);
  const importedPresentationTemplateResources$ =
    createImportedPresentationTemplateResources$(
      importedPresentationTemplates$,
      internalDetailVersion$,
    );
  const { internalRequestedTemplateId$, ...detailSignals } =
    createImportedPresentationTemplateDetailSignals(
      importedPresentationTemplateResources$,
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
    importedPresentationTemplateResources$,
    ...detailSignals,
    ...urlRefresh,
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
