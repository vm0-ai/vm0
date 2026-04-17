import { command, computed, state, type Command, type Computed } from "ccstate";
import { delay } from "signal-timers";
import { onRef, resetSignal, throwIfNotAbort } from "../utils.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { createScrollSignals } from "../auto-scroll.ts";
import {
  createDraftSignals,
  type DraftSignals,
  type ZeroChatAttachment,
} from "../zero-page/chat-draft.ts";
import {
  currentChatThreadId$,
  reloadChatThreads$,
  type ChatThread,
} from "../agent-chat.ts";
import {
  chatMessagesContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
  zeroRunsByIdContract,
  zeroRunsCancelContract,
  type PersistedAttachment,
  type PagedChatMessage,
} from "@vm0/core";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { agentById } from "../agent.ts";
import { pinnedAgentIds$ } from "../zero-page/zero-pinned-agents.ts";
import { writeToClipboard } from "../zero-page/clipboard.ts";
import type { GroupedChatMessageGroup } from "./chat-message.ts";
import { logger } from "../log.ts";

export type { DraftSignals } from "../zero-page/chat-draft.ts";

const L = logger("ChatThread");

// ---------------------------------------------------------------------------
// ChatThreadSignals — returned by createChatThreadSignals
// ---------------------------------------------------------------------------

export interface ChatThreadSignals {
  // ── Data signals ──────────────────────────────────────────────────────────
  threadData$: Computed<Promise<ChatThread | null>>;
  sendMessage$: Command<Promise<void>, [string, AbortSignal]>;
  cancelRun$: Command<Promise<void>, [AbortSignal]>;
  setScrollContainer$: Command<(() => void) | undefined, [HTMLElement | null]>;
  autoScroll$: Command<void, []>;
  scrollToBottom$: Command<void, []>;
  draft: DraftSignals;
  composerFileInput$: Computed<HTMLElement | null>;
  setComposerFileInput$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  // ── Agent info (derived from threadData$.agentId) ─────────────────────────
  agentId$: Computed<Promise<string | null>>;
  agentDisplayName$: Computed<Promise<string | null>>;
  agentPinned$: Computed<Promise<boolean | null>>;
  // ── Per-thread UI state ───────────────────────────────────────────────────
  timelineExpandedIds$: Computed<Set<string>>;
  toggleTimelineExpanded$: Command<void, [string]>;
  copiedMessageId$: Computed<string | null>;
  copyMessage$: Command<Promise<void>, [string, string, AbortSignal]>;
  // ── Focus ─────────────────────────────────────────────────────────────────
  setInputRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  focusInput$: Command<void, []>;
  // ── Draft sync ────────────────────────────────────────────────────────────
  scheduleDraftSync$: Command<void, [AbortSignal]>;
  // ── Paged messages (sole rendering path) ─────────────────────────────────
  pagedChatMessages$: Computed<PagedChatMessage[]>;
  latestChatMessageId$: Computed<string | undefined>;
  groupedChatMessages$: Computed<GroupedChatMessageGroup[]>;
  hasActiveRun$: Computed<boolean>;
  fetchNextPage$: Command<Promise<boolean>, [AbortSignal]>;
  loadPagedMessages$: Command<Promise<void>, [AbortSignal]>;
}

// ---------------------------------------------------------------------------
// Sub-factory: thread data fetching
// ---------------------------------------------------------------------------

function createThreadData(threadId: string) {
  const internalReload$ = state(0);

  const threadData$ = computed(async (get): Promise<ChatThread | null> => {
    get(internalReload$);
    const threadClient = get(zeroClient$)(chatThreadByIdContract);
    const threadResult = await accept(
      threadClient.get({ params: { id: threadId } }),
      [200],
    );
    const body = threadResult.body;
    return {
      id: threadId,
      title: body.title ?? null,
      agentId: body.agentId,
      latestSessionId: body.latestSessionId ?? null,
      activeRunIds: body.activeRunIds,
      isLegacySession: false,
      draftContent: body.draftContent ?? null,
      draftAttachments: body.draftAttachments ?? null,
    };
  });

  const reloadThread$ = command(({ set }) => {
    set(internalReload$, (v) => {
      return v + 1;
    });
  });

  return { threadData$, reloadThread$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: composer file input
// ---------------------------------------------------------------------------

function createComposerFileInput() {
  const internal$ = state<HTMLElement | null>(null);
  const composerFileInput$ = computed((get) => {
    return get(internal$);
  });
  const setComposerFileInput$ = onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        set(internal$, null);
      });
      set(internal$, el);
    }),
  );
  return { composerFileInput$, setComposerFileInput$ };
}

function createPrepareUserMessage(draft: DraftSignals) {
  return command(
    async (
      { get },
      prompt: string,
      signal: AbortSignal,
    ): Promise<{ fullPrompt: string; hasTextContent: boolean } | null> => {
      const allAttachments = get(draft.attachments$);
      const allInfos = await Promise.all(
        allAttachments.map((a) => {
          return get(a.fileInfo$);
        }),
      );
      signal.throwIfAborted();

      const ready = allAttachments
        .map((a, i) => {
          return { attachment: a, info: allInfos[i] };
        })
        .filter(
          (
            r,
          ): r is {
            attachment: ZeroChatAttachment;
            info: { id: string; url: string };
          } => {
            return r.info !== null;
          },
        );

      if (!prompt.trim() && ready.length === 0) {
        return null;
      }

      const attachmentLines = ready.map((r) => {
        return `[Attached file: ${r.attachment.filename}](${r.info.url})\nDownload with: curl -sL -o "${r.attachment.filename}" "${r.info.url}"`;
      });

      const trimmedPrompt = prompt.trim();
      const fullPrompt = trimmedPrompt
        ? attachmentLines.length > 0
          ? `${trimmedPrompt}\n\n${attachmentLines.join("\n")}`
          : trimmedPrompt
        : attachmentLines.join("\n");

      return { fullPrompt, hasTextContent: trimmedPrompt.length > 0 };
    },
  );
}

// ---------------------------------------------------------------------------
// Sub-factory: agent info
// ---------------------------------------------------------------------------

function createAgentInfoSignals(
  threadData$: Computed<Promise<ChatThread | null>>,
) {
  const agentId$ = computed(async (get): Promise<string | null> => {
    const thread = await get(threadData$);
    return thread?.agentId ?? null;
  });

  const agentDisplayName$ = computed(async (get): Promise<string | null> => {
    const agentId = await get(agentId$);
    if (!agentId) {
      return null;
    }
    const agent = await get(agentById(agentId));
    return agent?.displayName ?? null;
  });

  const agentPinned$ = computed(async (get): Promise<boolean | null> => {
    const agentId = await get(agentId$);
    if (!agentId) {
      return null;
    }
    const ids = await get(pinnedAgentIds$);
    return ids.includes(agentId);
  });

  return { agentId$, agentDisplayName$, agentPinned$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: per-thread UI state (timeline expansion, copy)
// ---------------------------------------------------------------------------

function createThreadUIState() {
  // Timeline expansion
  const internalExpandedIds$ = state(new Set<string>());

  const timelineExpandedIds$ = computed((get) => {
    return get(internalExpandedIds$);
  });

  const toggleTimelineExpanded$ = command(({ get, set }, messageId: string) => {
    const current = get(internalExpandedIds$);
    const next = new Set(current);
    if (next.has(messageId)) {
      next.delete(messageId);
    } else {
      next.add(messageId);
    }
    set(internalExpandedIds$, next);
  });

  // Copy state with 2s auto-clear
  const internalCopiedId$ = state<string | null>(null);
  const internalCopiedTimerId$ = state<number | null>(null);

  const copiedMessageId$ = computed((get) => {
    return get(internalCopiedId$);
  });

  const copyMessage$ = command(
    async (
      { get, set },
      messageId: string,
      content: string,
      signal: AbortSignal,
    ) => {
      const ok = await writeToClipboard(content);
      signal.throwIfAborted();
      if (!ok) {
        return;
      }
      const existingTimerId = get(internalCopiedTimerId$);
      if (existingTimerId !== null) {
        window.clearTimeout(existingTimerId);
      }
      set(internalCopiedId$, messageId);
      const timerId = window.setTimeout(() => {
        set(internalCopiedId$, null);
        set(internalCopiedTimerId$, null);
      }, 2000);
      set(internalCopiedTimerId$, timerId);
    },
  );

  return {
    timelineExpandedIds$,
    toggleTimelineExpanded$,
    copiedMessageId$,
    copyMessage$,
  };
}

// ---------------------------------------------------------------------------
// Sub-factory: draft server sync (debounced PATCH)
// ---------------------------------------------------------------------------

/** Milliseconds to wait before persisting a draft change to the server. */
const DRAFT_SYNC_DEBOUNCE_MS = 500;

// Backing state for the debounce delay — not exported directly (no-export-state rule).
const internalDraftSyncDebounceMs$ = state(DRAFT_SYNC_DEBOUNCE_MS);

/**
 * Overrides the debounce delay (ms) used by `scheduleDraftSync$`. Set to 0
 * in tests to bypass the 500ms wait without fake timers.
 *
 * @internal — exported for testing only; do not use in application code.
 */
export const setDraftSyncDebounceMs$ = command(({ set }, ms: number) => {
  set(internalDraftSyncDebounceMs$, ms);
});

function createDraftSync(threadId: string, draft: DraftSignals) {
  // A reset signal is used to abort any in-flight debounced sync when a new
  // change comes in or when the draft is cleared on send.
  const draftSyncReset$ = resetSignal();

  const syncWithContent$ = command(
    async (
      { get },
      content: string | null,
      attachments: PersistedAttachment[] | null,
      signal: AbortSignal,
    ) => {
      const client = get(zeroClient$)(chatThreadByIdContract);
      await accept(
        client.patch({
          params: { id: threadId },
          body: { draftContent: content, draftAttachments: attachments },
          fetchOptions: { signal },
        }),
        [204],
      );
    },
  );

  const debouncedSyncDraft$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      await delay(get(internalDraftSyncDebounceMs$), { signal });
      signal.throwIfAborted();

      const input = get(draft.input$);
      const content = input.trim() || null;
      const attachments = get(draft.attachments$);

      const infos = await Promise.all(
        attachments.map((a) => {
          return get(a.fileInfo$);
        }),
      );
      signal.throwIfAborted();
      const persisted = attachments
        .map((a, i) => {
          return { a, info: infos[i] };
        })
        .filter(
          (
            r,
          ): r is {
            a: ZeroChatAttachment;
            info: { id: string; url: string };
          } => {
            return r.info !== null;
          },
        )
        .map((r) => {
          return {
            id: r.info.id,
            url: r.info.url,
            filename: r.a.filename,
            contentType: r.a.contentType,
            size: r.a.size,
          };
        });

      await set(
        syncWithContent$,
        content,
        persisted.length > 0 ? persisted : null,
        signal,
      );
    },
  );

  const scheduleDraftSync$ = command(({ set }, signal: AbortSignal) => {
    const debouncedSignal = set(draftSyncReset$, signal);
    void set(debouncedSyncDraft$, debouncedSignal).catch(throwIfNotAbort);
  });

  const cancelDraftSync$ = command(({ set }) => {
    set(draftSyncReset$);
  });

  const flushDraftClear$ = command(async ({ set }, signal: AbortSignal) => {
    set(draftSyncReset$);
    await set(syncWithContent$, null, null, signal);
  });

  return { scheduleDraftSync$, cancelDraftSync$, flushDraftClear$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: paginated chat messages
// ---------------------------------------------------------------------------

/** Merge new messages into existing groups in place. */
function mergeIntoGroups(
  groups: GroupedChatMessageGroup[],
  messages: PagedChatMessage[],
): GroupedChatMessageGroup[] {
  const result = [...groups];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.messages = [...last.messages, msg];
    } else {
      result.push({
        beginMessageId: msg.id,
        role: msg.role,
        messages: [msg],
      });
    }
  }
  return result;
}

function createPagedMessages(threadId: string) {
  const internalGroups$ = state<GroupedChatMessageGroup[]>([]);

  const groupedChatMessages$ = computed((get) => {
    return get(internalGroups$);
  });

  const pagedChatMessages$ = computed((get) => {
    const groups = get(internalGroups$);
    const all: PagedChatMessage[] = [];
    for (const group of groups) {
      all.push(...group.messages);
    }
    return all;
  });

  const latestChatMessageId$ = computed((get) => {
    const groups = get(internalGroups$);
    const lastGroup = groups[groups.length - 1];
    if (!lastGroup) {
      return undefined;
    }
    const msgs = lastGroup.messages;
    return msgs[msgs.length - 1].id;
  });

  const fetchNextPage$ = command(async ({ get, set }, signal: AbortSignal) => {
    const sinceId = get(latestChatMessageId$);
    signal.throwIfAborted();

    const client = get(zeroClient$)(chatThreadMessagesContract);
    const result = await accept(
      client.list({
        params: { threadId },
        query: { sinceId, limit: 50 },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    L.debug("fetchNextPage$", {
      threadId,
      sinceId,
      count: result.body.messages.length,
      runStatuses: result.body.messages
        .filter((m) => {
          return m.runId;
        })
        .map((m) => {
          return { id: m.id, runId: m.runId, status: m.status };
        }),
    });

    if (result.body.messages.length === 0) {
      return true; // no new messages
    }

    set(internalGroups$, (prev) => {
      return mergeIntoGroups(prev, result.body.messages);
    });

    return false;
  });

  return {
    pagedChatMessages$,
    latestChatMessageId$,
    groupedChatMessages$,
    fetchNextPage$,
  };
}

// ---------------------------------------------------------------------------
// Draft cache
// ---------------------------------------------------------------------------

const draftCache$ = state(new Map<string, DraftSignals>());

export const ensureDraft$ = command(
  ({ get, set }, threadId: string): { draft: DraftSignals; isNew: boolean } => {
    const cache = get(draftCache$);
    const existing = cache.get(threadId);
    if (existing) {
      return { draft: existing, isNew: false };
    }
    const draft = createDraftSignals();
    const next = new Map(cache);
    next.set(threadId, draft);
    set(draftCache$, next);
    return { draft, isNew: true };
  },
);

function createInputRef() {
  const internalInputRef$ = state<HTMLElement | null>(null);
  const setInputRef$ = onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        set(internalInputRef$, null);
      });
      set(internalInputRef$, el);
    }),
  );
  const focusInput$ = command(({ get }) => {
    get(internalInputRef$)?.focus();
  });
  return { setInputRef$, focusInput$ };
}

// ---------------------------------------------------------------------------
// Factory: createRunTracking
// ---------------------------------------------------------------------------

function createRunTracking(
  threadId: string,
  threadData$: Computed<Promise<ChatThread | null>>,
  fetchNextPage$: Command<Promise<boolean>, [AbortSignal]>,
) {
  const pendingRunIds$ = state<string[]>([]);

  const terminalStatuses = new Set([
    "completed",
    "failed",
    "timeout",
    "cancelled",
  ]);

  const trackRun$ = command(
    async ({ get, set }, runId: string, signal: AbortSignal) => {
      const already = get(pendingRunIds$);
      if (already.includes(runId)) {
        L.debug("trackRun$ already tracking", { threadId, runId });
      } else {
        const next = [...already, runId];
        set(pendingRunIds$, next);
        L.debug("trackRun$ added to pendingRunIds", {
          threadId,
          runId,
          pendingRunIds: next,
        });
      }

      const checkRun$ = command(async ({ get, set }, sig: AbortSignal) => {
        const client = get(zeroClient$)(zeroRunsByIdContract);
        const res = await accept(
          client.getById({
            params: { id: runId },
            fetchOptions: { signal: sig },
          }),
          [200],
        );
        L.debug("checkRun$ poll", {
          threadId,
          runId,
          status: res.body.status,
        });
        if (terminalStatuses.has(res.body.status)) {
          set(pendingRunIds$, (ids) => {
            return ids.filter((id) => {
              return id !== runId;
            });
          });
          L.debug("checkRun$ terminal, removed from pendingRunIds", {
            threadId,
            runId,
            status: res.body.status,
            pendingRunIds: get(pendingRunIds$),
          });
          return true;
        }
        return false;
      });

      signal.addEventListener("abort", () => {
        L.debug("trackRun$ aborted", { threadId, runId });
      });
      await set(setAblyLoop$, `runUpdated:${runId}`, checkRun$, signal);
      L.debug("trackRun$ exited (terminal)", { threadId, runId });
    },
  );

  const hasActiveRun$ = computed((get) => {
    const pending = get(pendingRunIds$);
    L.debug("hasActiveRun$ recomputed", {
      threadId,
      hasActiveRun: pending.length > 0,
      pendingRunIds: pending,
    });
    return pending.length > 0;
  });

  const loadPagedMessages$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      L.debug("loadPagedMessages$ start", { threadId });
      await set(fetchNextPage$, signal);
      signal.throwIfAborted();

      // Track any runs that were already active when the page loaded.
      const thread = await get(threadData$);
      signal.throwIfAborted();
      if (!thread) {
        L.debug("loadPagedMessages$ no thread", { threadId });
        return;
      }
      L.debug("loadPagedMessages$ thread loaded", {
        threadId,
        activeRunIds: thread.activeRunIds,
      });

      await Promise.all([
        (async () => {
          const pagedLoopBody$ = command(async ({ set }, sig: AbortSignal) => {
            await set(fetchNextPage$, sig);
            return false;
          });

          await set(
            setAblyLoop$,
            `chatThreadMessageCreated:${threadId}`,
            pagedLoopBody$,
            signal,
          );
        })(),
        ...thread.activeRunIds.map((runId) => {
          return set(trackRun$, runId, signal);
        }),
      ]);
      signal.throwIfAborted();
    },
  );

  const cancelRun$ = command(async ({ get, set }, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroRunsCancelContract);
    const removedIds: string[] = [];
    const before = get(pendingRunIds$);
    L.debug("cancelRun$ start", { threadId, pendingRunIds: before });

    await Promise.all(
      before.map(async (runId) => {
        await accept(
          client.cancel({
            params: { id: runId },
            fetchOptions: { signal },
          }),
          [200],
        );
        removedIds.push(runId);
        L.debug("cancelRun$ server accepted cancel", { threadId, runId });
      }),
    );
    signal.throwIfAborted();

    set(pendingRunIds$, (x) => {
      return x.filter((id) => {
        return removedIds.indexOf(id) === -1;
      });
    });
    L.debug("cancelRun$ done", {
      threadId,
      removedIds,
      pendingRunIds: get(pendingRunIds$),
    });
  });

  return { trackRun$, hasActiveRun$, loadPagedMessages$, cancelRun$ };
}

// ---------------------------------------------------------------------------
// Factory: createChatThreadSignals
// ---------------------------------------------------------------------------

export function createChatThreadSignals(
  threadId: string,
  draft: DraftSignals,
): ChatThreadSignals {
  const { threadData$ } = createThreadData(threadId);
  const { setScrollContainer$, autoScroll$, scrollToBottom$ } =
    createScrollSignals();
  const { composerFileInput$, setComposerFileInput$ } =
    createComposerFileInput();
  const { agentId$, agentDisplayName$, agentPinned$ } =
    createAgentInfoSignals(threadData$);
  const {
    timelineExpandedIds$,
    toggleTimelineExpanded$,
    copiedMessageId$,
    copyMessage$,
  } = createThreadUIState();
  const {
    pagedChatMessages$,
    latestChatMessageId$,
    groupedChatMessages$,
    fetchNextPage$,
  } = createPagedMessages(threadId);

  const { scheduleDraftSync$, cancelDraftSync$, flushDraftClear$ } =
    createDraftSync(threadId, draft);

  const prepareUserMessage$ = createPrepareUserMessage(draft);

  const { trackRun$, hasActiveRun$, loadPagedMessages$, cancelRun$ } =
    createRunTracking(threadId, threadData$, fetchNextPage$);

  const sendMessage$ = command(
    async ({ get, set }, prompt: string, signal: AbortSignal) => {
      L.debug("sendMessage$ start", { threadId, promptLen: prompt.length });
      const thread = await get(threadData$);
      signal.throwIfAborted();
      const agentId = thread?.agentId;
      if (!agentId) {
        L.debug("sendMessage$ no agentId, abort", { threadId });
        return;
      }

      const result = await set(prepareUserMessage$, prompt, signal);
      if (!result) {
        L.debug("sendMessage$ prepare returned null, abort", { threadId });
        return;
      }
      signal.throwIfAborted();

      set(cancelDraftSync$);
      set(draft.clear$);
      await set(flushDraftClear$, signal);
      signal.throwIfAborted();

      const client = get(zeroClient$)(chatMessagesContract);
      const sendResult = await accept(
        client.send({
          body: {
            agentId,
            prompt: result.fullPrompt,
            threadId: threadId,
            hasTextContent: result.hasTextContent,
          },
          fetchOptions: { signal },
        }),
        [201],
      );
      signal.throwIfAborted();
      L.debug("sendMessage$ POST accepted", {
        threadId,
        runId: sendResult.body.runId,
      });

      set(reloadChatThreads$);

      // Track run until terminal — keeps sendLoadable in "loading" state
      // so the UI stays in sending mode until the run finishes.
      await set(trackRun$, sendResult.body.runId, signal);
      L.debug("sendMessage$ done, trackRun resolved", {
        threadId,
        runId: sendResult.body.runId,
      });
    },
  );

  const { setInputRef$, focusInput$ } = createInputRef();

  return {
    threadData$,
    sendMessage$,
    cancelRun$,
    setScrollContainer$,
    autoScroll$,
    scrollToBottom$,
    draft,
    composerFileInput$,
    setComposerFileInput$,
    agentId$,
    agentDisplayName$,
    agentPinned$,
    timelineExpandedIds$,
    toggleTimelineExpanded$,
    copiedMessageId$,
    copyMessage$,
    setInputRef$,
    focusInput$,
    scheduleDraftSync$,
    pagedChatMessages$,
    latestChatMessageId$,
    groupedChatMessages$,
    hasActiveRun$,
    fetchNextPage$,
    loadPagedMessages$,
  };
}

// ---------------------------------------------------------------------------
// Package-scope computed: derives ChatThreadSignals from the current route
// ---------------------------------------------------------------------------

export const currentChatThreadSignals$ = computed(
  (get): ChatThreadSignals | null => {
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      return null;
    }
    const cache = get(draftCache$);
    const draft = cache.get(threadId);
    if (!draft) {
      return null;
    }
    return createChatThreadSignals(threadId, draft);
  },
);
