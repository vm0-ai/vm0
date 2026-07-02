import { command, computed, state } from "ccstate";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroHostContract } from "@vm0/api-contracts/contracts/zero-host";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  replaceSearchParams$,
  searchParams$,
  updateSearchParams$,
} from "../route.ts";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import {
  markDetachedErrorHandled,
  onRef,
  resetSignal,
  tapError,
  withCleanup,
} from "../utils.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import {
  classifyChatAttachment,
  previewAttachmentFromUrl,
} from "../chat-page/parse-body-blocks.ts";
import {
  type AttachmentArtifactMetadata,
  openAudioLightbox$ as openAudioLightboxModal$,
  openDocumentLightbox$ as openDocumentLightboxModal$,
  openImageLightbox$ as openImageLightboxModal$,
  openVideoLightbox$ as openVideoLightboxModal$,
} from "./zero-attachment-chips.ts";
import {
  ARTIFACT_FULLSCREEN_PARAM,
  ARTIFACT_HTML_EDIT_PARAM,
  ARTIFACT_INBOX_QUERY_PARAM,
  ARTIFACT_QUERY_PARAM,
  clearArtifactSidebarParams,
  clearChatAutomationSidebarParams,
  PRESENTATION_EDITOR_QUERY_PARAM,
} from "./right-sidebar-search-params.ts";
import { refreshPresentationHtmlPreviews$ } from "./presentation-html-cache-bust.ts";
import { readableAttachmentResourceUrl } from "../../views/zero-page/zero-attachment-url.ts";

// ---------------------------------------------------------------------------
// Artifact sidebar — URL-routed page-level slot for previewing a single
// attachment next to the chat thread area.
//
// Most sidebar navigation state lives in search params: `?artifacts=<threadId>`
// opens the artifact inbox, `?artifact=<url>` opens a detail preview, and
// `?artifact-fullscreen=1` expands whichever artifact surface is active. HTML
// edit drafts keep URL-keyed in-memory state so generated previews can survive
// sidebar remounts before the user publishes or discards them.
// ---------------------------------------------------------------------------

const IMAGE_ID_PREFIX = "image:";

export type ArtifactInboxSection = "all" | "media" | "docs" | "sites";

const internalArtifactInboxSection$ = state<ArtifactInboxSection>("all");
const internalArtifactInboxQuery$ = state("");
const internalArtifactInboxSearchOpen$ = state(false);
const internalHtmlDomEditPendingUrl$ = state<string | null>(null);
const internalHtmlDomEditPublishingUrl$ = state<string | null>(null);
const internalHtmlDomEditPreviewHtmlByUrl$ = state<
  Readonly<Record<string, string>>
>({});
const resetHtmlDomEditPublishSignal$ = resetSignal();
const resetHtmlEditSnapshotLoadSignal$ = resetSignal();

interface HtmlEditSnapshotRestoreDraft {
  readonly threadId: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly snapshotUrl: string;
}

interface ActiveHtmlEditSnapshotTarget {
  readonly threadId: string;
  readonly url: string;
}

interface HtmlEditSnapshotSaveArgs {
  readonly html: string;
  readonly threadId: string;
  readonly url: string;
}

const internalHtmlEditSnapshotRestoreDraft$ =
  state<HtmlEditSnapshotRestoreDraft | null>(null);
const internalActiveHtmlEditSnapshotTarget$ =
  state<ActiveHtmlEditSnapshotTarget | null>(null);
// In-flight save chain per `threadId\nurl`, so delete can await it.
const internalHtmlEditSnapshotSaveByKey$ = state<
  Readonly<Record<string, Promise<void>>>
>({});
// Draft HTML prefetched when a restorable draft is detected, so Resume applies
// without a round-trip. Keyed by `threadId\nurl`; cleared on target change.
const internalHtmlEditSnapshotContentByKey$ = state<
  Readonly<Record<string, string>>
>({});
// Bumped whenever a snapshot is deleted, so a save enqueued before the delete
// skips its upsert instead of resurrecting the just-deleted draft.
const internalHtmlEditSnapshotDeleteEpochByKey$ = state<
  Readonly<Record<string, number>>
>({});

function htmlEditSnapshotKey(threadId: string, url: string): string {
  return `${threadId}\n${url}`;
}

async function upsertHtmlEditSnapshot(
  createClient: ZeroClientFactory,
  args: HtmlEditSnapshotSaveArgs,
): Promise<void> {
  const client = createClient(chatThreadArtifactsContract, { apiBase: "api" });
  await accept(
    client.upsertHtmlEditSnapshot({
      params: { threadId: args.threadId },
      body: { url: args.url, html: args.html },
    }),
    [200],
  );
}

// Fetch the saved draft HTML from its snapshot URL, or null if it no longer
// exists (404). The snapshot URL is a versioned CDN link returned by
// getHtmlEditSnapshot.
async function fetchHtmlEditSnapshotContent(
  snapshotUrl: string,
  signal: AbortSignal,
): Promise<string | null> {
  const response = await fetch(readableAttachmentResourceUrl(snapshotUrl), {
    cache: "reload",
    mode: "cors",
    signal,
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load saved draft (${response.status})`);
  }
  return response.text();
}

// Persist the Send-generated draft for its captured thread + url, fire-and-forget
// (not gated on the active target) so it lands even if the agent returns after
// the user switched chats. Saves for the same key chain so a slow older upload
// can't clobber a newer draft, and the promise is tracked so delete can await it.
export const saveCapturedHtmlEditSnapshotDraft$ = command(
  ({ get, set }, args: HtmlEditSnapshotSaveArgs) => {
    const createClient = get(zeroClient$);
    const key = htmlEditSnapshotKey(args.threadId, args.url);
    // A newer draft invalidates any content prefetched for the same target, so
    // Resume never applies stale HTML.
    if (key in get(internalHtmlEditSnapshotContentByKey$)) {
      const nextContent = { ...get(internalHtmlEditSnapshotContentByKey$) };
      delete nextContent[key];
      set(internalHtmlEditSnapshotContentByKey$, nextContent);
    }
    const epoch = get(internalHtmlEditSnapshotDeleteEpochByKey$)[key] ?? 0;
    const previous = get(internalHtmlEditSnapshotSaveByKey$)[key];

    const run = async () => {
      if (typeof previous !== "undefined") {
        await previous;
      }
      // Skip if the snapshot was deleted after this save was enqueued, so a
      // stale save can't resurrect a discarded/published draft.
      if (
        (get(internalHtmlEditSnapshotDeleteEpochByKey$)[key] ?? 0) !== epoch
      ) {
        return;
      }
      await tapError(
        upsertHtmlEditSnapshot(createClient, args),
        markDetachedErrorHandled,
      );
    };

    const queue = withCleanup(run(), () => {
      if (get(internalHtmlEditSnapshotSaveByKey$)[key] === queue) {
        const next = { ...get(internalHtmlEditSnapshotSaveByKey$) };
        delete next[key];
        set(internalHtmlEditSnapshotSaveByKey$, next);
      }
    });
    set(internalHtmlEditSnapshotSaveByKey$, {
      ...get(internalHtmlEditSnapshotSaveByKey$),
      [key]: queue,
    });
  },
);

const waitForHtmlEditSnapshotSaveQueue$ = command(
  async (
    { get },
    args: { readonly threadId: string; readonly url: string },
    signal: AbortSignal,
  ) => {
    const queue = get(internalHtmlEditSnapshotSaveByKey$)[
      htmlEditSnapshotKey(args.threadId, args.url)
    ];
    if (typeof queue === "undefined") {
      return;
    }
    // The chain never rejects (failures handled inside); just let it settle.
    await queue;
    signal.throwIfAborted();
  },
);

function htmlEditSnapshotTargetMatches(
  active: ActiveHtmlEditSnapshotTarget | null,
  args: { readonly threadId: string; readonly url: string },
): boolean {
  return active?.threadId === args.threadId && active.url === args.url;
}

export type ArtifactPreviewKind =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "html"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "file";

export type ArtifactRef =
  | {
      source: "url";
      url: string;
      kind: ArtifactPreviewKind;
      filename: string;
    }
  | {
      source: "image-id";
      imageId: string;
    };

function decodeArtifactParam(value: string): ArtifactRef | null {
  if (value.startsWith(IMAGE_ID_PREFIX)) {
    const imageId = value.slice(IMAGE_ID_PREFIX.length);
    if (!imageId) {
      return null;
    }
    return { source: "image-id", imageId };
  }
  return null;
}

export const currentArtifactInboxThreadId$ = computed((get) => {
  return get(searchParams$).get(ARTIFACT_INBOX_QUERY_PARAM);
});

export const artifactInboxSection$ = computed((get) => {
  return get(internalArtifactInboxSection$);
});

export const artifactInboxQuery$ = computed((get) => {
  return get(internalArtifactInboxQuery$);
});

export const artifactInboxSearchOpen$ = computed((get) => {
  return get(internalArtifactInboxSearchOpen$);
});

// The URL alone is the source of truth: kind + filename are derived from
// the URL itself via previewAttachmentFromUrl, so deep-linking or refreshing
// the page re-renders the right body without any in-memory metadata cache.
// Reusing previewAttachmentFromUrl keeps hosted-site URLs (e.g.
// *.sites.vm0.io) classified as html, matching how the chat body renders
// them.
export const currentArtifactRef$ = computed<ArtifactRef | null>((get) => {
  const params = get(searchParams$);
  const raw = params.get(ARTIFACT_QUERY_PARAM);
  if (!raw) {
    return null;
  }
  if (raw.startsWith(IMAGE_ID_PREFIX)) {
    return decodeArtifactParam(raw);
  }
  const attachment = previewAttachmentFromUrl(raw);
  const kind = classifyChatAttachment(attachment);
  return { source: "url", url: raw, kind, filename: attachment.filename };
});

export const currentPresentationEditorUrl$ = computed((get) => {
  return get(searchParams$).get(PRESENTATION_EDITOR_QUERY_PARAM);
});

function setArtifactPreviewParams(
  params: URLSearchParams,
  args: {
    readonly fullscreen: boolean;
    readonly htmlEdit: boolean;
    readonly url: string;
  },
): void {
  params.set(ARTIFACT_QUERY_PARAM, args.url);
  if (args.htmlEdit) {
    params.set(ARTIFACT_HTML_EDIT_PARAM, "1");
  } else {
    params.delete(ARTIFACT_HTML_EDIT_PARAM);
  }
  params.delete(ARTIFACT_INBOX_QUERY_PARAM);
  if (args.fullscreen) {
    params.set(ARTIFACT_FULLSCREEN_PARAM, "1");
  } else {
    params.delete(ARTIFACT_FULLSCREEN_PARAM);
  }
  clearChatAutomationSidebarParams(params);
}

export const openArtifactSidebarPreview$ = command(
  ({ get, set }, url: string) => {
    const params = new URLSearchParams(get(searchParams$));
    setArtifactPreviewParams(params, {
      fullscreen: false,
      htmlEdit: false,
      url,
    });
    set(updateSearchParams$, params);
  },
);

type OpenArtifactSidebarHtmlEditArgs =
  | string
  | {
      readonly fullscreen: boolean;
      readonly url: string;
    };

export const openArtifactSidebarHtmlEdit$ = command(
  ({ get, set }, value: OpenArtifactSidebarHtmlEditArgs) => {
    const params = new URLSearchParams(get(searchParams$));
    const args =
      typeof value === "string" ? { fullscreen: false, url: value } : value;
    setArtifactPreviewParams(params, {
      fullscreen: args.fullscreen,
      htmlEdit: true,
      url: args.url,
    });
    set(updateSearchParams$, params);
  },
);

export const openPresentationEditor$ = command(({ get, set }, url: string) => {
  const params = new URLSearchParams(get(searchParams$));
  params.set(PRESENTATION_EDITOR_QUERY_PARAM, url);
  params.set(ARTIFACT_FULLSCREEN_PARAM, "1");
  params.delete(ARTIFACT_QUERY_PARAM);
  params.delete(ARTIFACT_INBOX_QUERY_PARAM);
  params.delete(ARTIFACT_HTML_EDIT_PARAM);
  clearChatAutomationSidebarParams(params);
  set(updateSearchParams$, params);
});

export const closePresentationEditor$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (!params.has(PRESENTATION_EDITOR_QUERY_PARAM)) {
    return;
  }
  params.delete(PRESENTATION_EDITOR_QUERY_PARAM);
  params.delete(ARTIFACT_FULLSCREEN_PARAM);
  set(replaceSearchParams$, params);
});

export const openArtifactInbox$ = command(({ get, set }, threadId: string) => {
  const params = new URLSearchParams(get(searchParams$));
  params.set(ARTIFACT_INBOX_QUERY_PARAM, threadId);
  params.delete(ARTIFACT_QUERY_PARAM);
  params.delete(ARTIFACT_FULLSCREEN_PARAM);
  params.delete(ARTIFACT_HTML_EDIT_PARAM);
  clearChatAutomationSidebarParams(params);
  set(internalArtifactInboxSection$, "all");
  set(internalArtifactInboxQuery$, "");
  set(internalArtifactInboxSearchOpen$, false);
  set(updateSearchParams$, params);
});

export const setArtifactInboxSection$ = command(
  ({ set }, value: ArtifactInboxSection) => {
    set(internalArtifactInboxSection$, value);
  },
);

export const setArtifactInboxQuery$ = command(({ set }, value: string) => {
  set(internalArtifactInboxQuery$, value);
});

export const toggleArtifactInboxSearch$ = command(({ get, set }) => {
  const nextOpen = !get(internalArtifactInboxSearchOpen$);
  set(internalArtifactInboxSearchOpen$, nextOpen);
  if (!nextOpen) {
    set(internalArtifactInboxQuery$, "");
  }
});

export const openArtifactFromInbox$ = command(
  ({ get, set }, args: { threadId: string; url: string }) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set(ARTIFACT_INBOX_QUERY_PARAM, args.threadId);
    params.set(ARTIFACT_QUERY_PARAM, args.url);
    params.delete(ARTIFACT_FULLSCREEN_PARAM);
    params.delete(ARTIFACT_HTML_EDIT_PARAM);
    clearChatAutomationSidebarParams(params);
    set(updateSearchParams$, params);
  },
);

export const navigateArtifactSidebarImage$ = command(
  ({ get, set }, url: string) => {
    const params = new URLSearchParams(get(searchParams$));
    params.set(ARTIFACT_QUERY_PARAM, url);
    params.delete(ARTIFACT_HTML_EDIT_PARAM);
    clearChatAutomationSidebarParams(params);
    set(updateSearchParams$, params);
  },
);

export const backToArtifactInbox$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  params.delete(ARTIFACT_QUERY_PARAM);
  params.delete(ARTIFACT_FULLSCREEN_PARAM);
  params.delete(ARTIFACT_HTML_EDIT_PARAM);
  set(replaceSearchParams$, params);
});

export const closeArtifact$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (
    !params.has(ARTIFACT_QUERY_PARAM) &&
    !params.has(ARTIFACT_INBOX_QUERY_PARAM) &&
    !params.has(ARTIFACT_FULLSCREEN_PARAM)
  ) {
    return;
  }
  clearArtifactSidebarParams(params);
  set(replaceSearchParams$, params);
});

export const clearArtifactPreview$ = command(({ set }) => {
  set(closeArtifact$);
});

export const artifactFullscreen$ = computed((get) => {
  return get(searchParams$).get(ARTIFACT_FULLSCREEN_PARAM) === "1";
});

export const artifactHtmlEditMode$ = computed((get) => {
  return get(searchParams$).get(ARTIFACT_HTML_EDIT_PARAM) === "1";
});

export const htmlDomEditPendingUrl$ = computed((get) => {
  return get(internalHtmlDomEditPendingUrl$);
});

export const htmlDomEditPublishingUrl$ = computed((get) => {
  return get(internalHtmlDomEditPublishingUrl$);
});

export const htmlDomEditPreviewHtmlByUrl$ = computed((get) => {
  return get(internalHtmlDomEditPreviewHtmlByUrl$);
});

export const htmlEditSnapshotRestoreDraft$ = computed((get) => {
  return get(internalHtmlEditSnapshotRestoreDraft$);
});

// Dismiss the restore prompt without acting on it (the draft stays in the DB and
// is offered again next time the artifact is opened).
export const dismissHtmlEditSnapshotRestoreDraft$ = command(({ set }) => {
  set(internalHtmlEditSnapshotRestoreDraft$, null);
});

const setActiveHtmlEditSnapshotTarget$ = command(
  (
    { get, set },
    target: { readonly threadId: string; readonly url: string } | null,
  ) => {
    const current = get(internalActiveHtmlEditSnapshotTarget$);
    if (
      current?.threadId === target?.threadId &&
      current?.url === target?.url
    ) {
      return;
    }

    set(internalActiveHtmlEditSnapshotTarget$, target);
    set(resetHtmlEditSnapshotLoadSignal$);
    set(internalHtmlEditSnapshotContentByKey$, {});
    if (
      !target ||
      get(internalHtmlEditSnapshotRestoreDraft$)?.threadId !==
        target.threadId ||
      get(internalHtmlEditSnapshotRestoreDraft$)?.url !== target.url
    ) {
      set(internalHtmlEditSnapshotRestoreDraft$, null);
    }
  },
);

export const loadHtmlEditSnapshotRestoreDraft$ = command(
  async (
    { get, set },
    args: {
      readonly threadId: string;
      readonly url: string;
    },
    signal: AbortSignal,
  ) => {
    const active = get(internalActiveHtmlEditSnapshotTarget$);
    if (!htmlEditSnapshotTargetMatches(active, args)) {
      return;
    }
    const loadSignal = set(resetHtmlEditSnapshotLoadSignal$, signal);

    const client = get(zeroClient$)(chatThreadArtifactsContract, {
      apiBase: "api",
    });
    const response = await tapError(
      accept(
        client.getHtmlEditSnapshot({
          params: { threadId: args.threadId },
          query: { url: args.url },
          fetchOptions: { signal: loadSignal },
        }),
        [200],
        { toast: false },
      ),
      markDetachedErrorHandled,
    );
    signal.throwIfAborted();
    loadSignal.throwIfAborted();
    if (!response) {
      return;
    }
    const current = get(internalActiveHtmlEditSnapshotTarget$);
    if (!htmlEditSnapshotTargetMatches(current, args)) {
      return;
    }
    if (!response.body.snapshot) {
      set(internalHtmlEditSnapshotRestoreDraft$, null);
      return;
    }
    const { snapshotUrl } = response.body.snapshot;
    set(internalHtmlEditSnapshotRestoreDraft$, {
      threadId: args.threadId,
      updatedAt: response.body.snapshot.updatedAt,
      url: args.url,
      snapshotUrl,
    });

    // Prefetch the draft HTML in the background so Resume applies instantly.
    const html = await tapError(
      fetchHtmlEditSnapshotContent(snapshotUrl, loadSignal),
      markDetachedErrorHandled,
    );
    signal.throwIfAborted();
    loadSignal.throwIfAborted();
    if (
      typeof html === "string" &&
      htmlEditSnapshotTargetMatches(
        get(internalActiveHtmlEditSnapshotTarget$),
        args,
      )
    ) {
      set(internalHtmlEditSnapshotContentByKey$, {
        ...get(internalHtmlEditSnapshotContentByKey$),
        [htmlEditSnapshotKey(args.threadId, args.url)]: html,
      });
    }
  },
);

export const deleteHtmlEditSnapshotDraft$ = command(
  async (
    { get, set },
    args: { readonly threadId: string; readonly url: string },
    signal: AbortSignal,
  ) => {
    const key = htmlEditSnapshotKey(args.threadId, args.url);
    // Bump the epoch synchronously so any already-enqueued save skips its upsert
    // rather than resurrecting this snapshot after we delete it.
    set(internalHtmlEditSnapshotDeleteEpochByKey$, {
      ...get(internalHtmlEditSnapshotDeleteEpochByKey$),
      [key]: (get(internalHtmlEditSnapshotDeleteEpochByKey$)[key] ?? 0) + 1,
    });
    // Let any in-flight save settle first so its upsert can't land after the
    // delete and resurrect a stale snapshot.
    await set(
      waitForHtmlEditSnapshotSaveQueue$,
      {
        threadId: args.threadId,
        url: args.url,
      },
      signal,
    );
    signal.throwIfAborted();

    const client = get(zeroClient$)(chatThreadArtifactsContract, {
      apiBase: "api",
    });
    await accept(
      client.deleteHtmlEditSnapshot({
        params: { threadId: args.threadId },
        query: { url: args.url },
        fetchOptions: { signal },
      }),
      [204],
      { toast: false },
    );
    signal.throwIfAborted();

    const nextContent = { ...get(internalHtmlEditSnapshotContentByKey$) };
    delete nextContent[key];
    set(internalHtmlEditSnapshotContentByKey$, nextContent);

    const restoreDraft = get(internalHtmlEditSnapshotRestoreDraft$);
    if (
      restoreDraft?.threadId === args.threadId &&
      restoreDraft.url === args.url
    ) {
      set(internalHtmlEditSnapshotRestoreDraft$, null);
    }
  },
);

export const continueHtmlEditSnapshotDraft$ = command(
  async (
    { get, set },
    args: {
      readonly threadId: string;
      readonly url: string;
    },
    signal: AbortSignal,
  ) => {
    // Use the draft HTML prefetched at detection time when available; otherwise
    // fetch it now from the restore draft's snapshot URL.
    const cached = get(internalHtmlEditSnapshotContentByKey$)[
      htmlEditSnapshotKey(args.threadId, args.url)
    ];
    let html: string | null;
    if (typeof cached === "string") {
      html = cached;
    } else {
      const restoreDraft = get(internalHtmlEditSnapshotRestoreDraft$);
      const snapshotUrl =
        restoreDraft?.threadId === args.threadId &&
        restoreDraft.url === args.url
          ? restoreDraft.snapshotUrl
          : null;
      html = snapshotUrl
        ? await fetchHtmlEditSnapshotContent(snapshotUrl, signal)
        : null;
    }
    signal.throwIfAborted();
    // The user may have switched artifact/thread during the fetch; don't apply a
    // draft preview to a target they navigated away from.
    if (
      !htmlEditSnapshotTargetMatches(
        get(internalActiveHtmlEditSnapshotTarget$),
        args,
      )
    ) {
      return;
    }
    if (html === null) {
      set(internalHtmlEditSnapshotRestoreDraft$, null);
      toast.error("Saved draft is no longer available");
      return;
    }

    // Restore the draft as a publishable preview: write it into the preview map
    // and leave comment-edit mode so the Publish/Discard toolbar shows.
    set(internalHtmlDomEditPreviewHtmlByUrl$, {
      ...get(internalHtmlDomEditPreviewHtmlByUrl$),
      [args.url]: html,
    });
    set(internalHtmlDomEditPendingUrl$, null);
    const params = new URLSearchParams(get(searchParams$));
    params.delete(ARTIFACT_HTML_EDIT_PARAM);
    set(replaceSearchParams$, params);
    await set(
      deleteHtmlEditSnapshotDraft$,
      {
        threadId: args.threadId,
        url: args.url,
      },
      signal,
    );
  },
);

export const markHtmlDomEditPending$ = command(({ set }, url: string) => {
  set(internalHtmlDomEditPendingUrl$, url);
});

export const applyHtmlDomEditPreview$ = command(
  ({ get, set }, params: { readonly url: string; readonly html: string }) => {
    set(internalHtmlDomEditPreviewHtmlByUrl$, {
      ...get(internalHtmlDomEditPreviewHtmlByUrl$),
      [params.url]: params.html,
    });
    set(internalHtmlDomEditPendingUrl$, null);
  },
);

export const currentHtmlDomEditPreviewHtml$ = command(
  ({ get }, url: string) => {
    return get(internalHtmlDomEditPreviewHtmlByUrl$)[url] ?? null;
  },
);

export const setHtmlEditSnapshotControllerRef$ = onRef(
  command(async ({ set }, el: HTMLDivElement, signal: AbortSignal) => {
    const threadId = el.dataset.htmlEditSnapshotThreadId;
    const url = el.dataset.htmlEditSnapshotUrl;
    if (!threadId || !url) {
      set(setActiveHtmlEditSnapshotTarget$, null);
      return;
    }

    const target = { threadId, url };
    set(setActiveHtmlEditSnapshotTarget$, target);

    signal.addEventListener(
      "abort",
      () => {
        set(setActiveHtmlEditSnapshotTarget$, null);
      },
      { once: true },
    );

    await set(loadHtmlEditSnapshotRestoreDraft$, target, signal);
  }),
);

export const discardHtmlDomEditPreviewDraft$ = command(
  async (
    { get, set },
    args:
      | string
      | {
          readonly threadId?: string;
          readonly url: string;
        },
    signal: AbortSignal,
  ) => {
    const url = typeof args === "string" ? args : args.url;
    const next = { ...get(internalHtmlDomEditPreviewHtmlByUrl$) };
    delete next[url];
    set(internalHtmlDomEditPreviewHtmlByUrl$, next);

    const params = new URLSearchParams(get(searchParams$));
    params.set(ARTIFACT_HTML_EDIT_PARAM, "1");
    set(replaceSearchParams$, params);

    if (typeof args !== "string" && args.threadId) {
      await set(
        deleteHtmlEditSnapshotDraft$,
        {
          threadId: args.threadId,
          url,
        },
        signal,
      );
    }
  },
);

export const publishHtmlDomEditPreviewDraft$ = command(
  async (
    { get, set },
    args:
      | string
      | {
          readonly threadId?: string;
          readonly url: string;
        },
    parentSignal: AbortSignal,
  ) => {
    const url = typeof args === "string" ? args : args.url;
    const html = get(internalHtmlDomEditPreviewHtmlByUrl$)[url];
    if (!html || get(internalHtmlDomEditPublishingUrl$) === url) {
      return;
    }

    const signal = set(resetHtmlDomEditPublishSignal$, parentSignal);
    set(internalHtmlDomEditPublishingUrl$, url);
    const publish = async () => {
      const client = get(zeroClient$)(zeroHostContract, { apiBase: "api" });
      await accept(
        client.redeployHtml({
          body: { url, html },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();

      const next = { ...get(internalHtmlDomEditPreviewHtmlByUrl$) };
      delete next[url];
      set(internalHtmlDomEditPreviewHtmlByUrl$, next);
      set(internalHtmlDomEditPendingUrl$, null);

      const params = new URLSearchParams(get(searchParams$));
      params.delete(ARTIFACT_HTML_EDIT_PARAM);
      set(replaceSearchParams$, params);
      set(refreshPresentationHtmlPreviews$);
      toast.success("Site published");

      // The site is already live; clearing the saved snapshot is best-effort and
      // must not turn a successful publish into a reported failure.
      if (typeof args !== "string" && args.threadId) {
        await tapError(
          set(
            deleteHtmlEditSnapshotDraft$,
            {
              threadId: args.threadId,
              url,
            },
            signal,
          ),
          markDetachedErrorHandled,
        );
      }
    };

    await withCleanup(publish(), () => {
      if (!signal.aborted && get(internalHtmlDomEditPublishingUrl$) === url) {
        set(internalHtmlDomEditPublishingUrl$, null);
      }
    });
  },
);

export const clearHtmlDomEditPending$ = command(
  ({ get, set }, url?: string) => {
    const pendingUrl = get(internalHtmlDomEditPendingUrl$);
    if (url && pendingUrl !== url) {
      return;
    }
    set(internalHtmlDomEditPendingUrl$, null);
  },
);

export const openArtifactHtmlEditMode$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  params.set(ARTIFACT_HTML_EDIT_PARAM, "1");
  set(replaceSearchParams$, params);
});

export const closeArtifactHtmlEditMode$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  params.delete(ARTIFACT_HTML_EDIT_PARAM);
  set(replaceSearchParams$, params);
});

export const toggleArtifactFullscreen$ = command(({ get, set }) => {
  const params = new URLSearchParams(get(searchParams$));
  if (params.get(ARTIFACT_FULLSCREEN_PARAM) === "1") {
    params.delete(ARTIFACT_FULLSCREEN_PARAM);
  } else {
    params.set(ARTIFACT_FULLSCREEN_PARAM, "1");
  }
  set(updateSearchParams$, params);
});

// ---------------------------------------------------------------------------
// Attachment preview clicks still open the modal lightbox. Moving into the
// artifact sidebar is an explicit lightbox action so chat previews do not jump
// directly into split view.
// ---------------------------------------------------------------------------

export const openImageLightboxOrArtifact$ = command(
  (
    { set },
    value:
      | string
      | {
          url: string;
          filename?: string;
          artifact?: AttachmentArtifactMetadata;
        },
  ) => {
    set(openImageLightboxModal$, value);
  },
);

export const openVideoLightboxOrArtifact$ = command(
  (
    { set },
    value: {
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
    },
  ) => {
    set(openVideoLightboxModal$, value);
  },
);

export const openAudioLightboxOrArtifact$ = command(
  (
    { set },
    value: {
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
    },
  ) => {
    set(openAudioLightboxModal$, value);
  },
);

export const openDocumentLightboxOrArtifact$ = command(
  (
    { set },
    value: {
      kind: "markdown" | "text" | "json" | "csv" | "html" | "pdf";
      url: string;
      filename: string;
      artifact?: AttachmentArtifactMetadata;
    },
  ) => {
    set(openDocumentLightboxModal$, value);
  },
);

// ---------------------------------------------------------------------------
// Artifact panel width — user-resizable split between the chat thread and the
// artifact preview at xl+ breakpoints. Persisted in localStorage as a pixel
// width; clamping against the live viewport happens at render via CSS clamp().
// `null` means "never resized" and falls back to the responsive default.
// ---------------------------------------------------------------------------

// Smallest the preview may shrink to before content stops being usable.
export const ARTIFACT_PANEL_MIN_WIDTH = 400;
// Width the chat thread is guaranteed to keep so its composer never collapses.
export const ARTIFACT_PANEL_MIN_THREAD_WIDTH = 600;

const { get$: artifactPanelWidthRaw$, set$: setArtifactPanelWidthRaw$ } =
  localStorageSignals("artifactPanelWidth");

export const artifactPanelWidth$ = computed<number | null>((get) => {
  const raw = get(artifactPanelWidthRaw$);
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
});

export const setArtifactPanelWidth$ = command(({ set }, width: number) => {
  set(setArtifactPanelWidthRaw$, String(Math.round(width)));
});

// True while the user is dragging the divider, so the panels can drop their
// width transition and track the pointer without lag.
const internalArtifactPanelResizing$ = state(false);
export const artifactPanelResizing$ = computed((get) => {
  return get(internalArtifactPanelResizing$);
});
export const setArtifactPanelResizing$ = command(
  ({ set }, resizing: boolean) => {
    set(internalArtifactPanelResizing$, resizing);
  },
);
