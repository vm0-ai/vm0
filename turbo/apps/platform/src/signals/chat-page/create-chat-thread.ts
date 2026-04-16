import { command, computed, state, type Command, type Computed } from "ccstate";
import { delay } from "signal-timers";
import { onRef, resetSignal, throwIfNotAbort } from "../utils.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { createScrollSignals } from "../auto-scroll.ts";
import { logger } from "../log.ts";
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
  type PersistedAttachment,
  type AttachFile,
} from "@vm0/core";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { agentById } from "../agent.ts";
import { pinnedAgentIds$ } from "../zero-page/zero-pinned-agents.ts";
import { writeToClipboard } from "../zero-page/clipboard.ts";
import {
  createActiveRunMessage,
  createPlaceholderAssistantMessage,
  transformServerMessages,
  THINKING_MESSAGES,
  type ChatMessages,
  type ZeroChatMessage,
  type UserChatMessage,
  type AssistantChatMessage,
} from "./chat-message.ts";
import {
  markMessageLoading$,
  checkAutoRead$,
} from "../voice-io/voice-io-tts.ts";

export type { DraftSignals } from "../zero-page/chat-draft.ts";

const L = logger("ChatThread");

// ---------------------------------------------------------------------------
// ChatThreadSignals — returned by createChatThreadSignals
// ---------------------------------------------------------------------------

export interface ChatThreadSignals {
  // ── Data signals ──────────────────────────────────────────────────────────
  threadData$: Computed<Promise<ChatThread | null>>;
  messages$: Computed<Promise<ZeroChatMessage[]>>;
  allFinished$: Computed<Promise<boolean>>;
  thinkingMessage$: Computed<string>;
  loadMessages$: Command<Promise<void>, [AbortSignal]>;
  sendMessage$: Command<Promise<void>, [string, AbortSignal]>;
  cancelRun$: Command<Promise<void>, [AbortSignal]>;
  resetLocalMessages$: Command<void, []>;
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
  /** Schedule a 500ms debounced PATCH to persist the current draft to the server. */
  scheduleDraftSync$: Command<void, [AbortSignal]>;
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
      chatMessages: body.chatMessages ?? [],
      latestSessionId: body.latestSessionId ?? null,
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
// Sub-factory: message state (local messages, merged messages, allFinished)
// ---------------------------------------------------------------------------

function createMessageState(threadData$: Computed<Promise<ChatThread | null>>) {
  const internalLocalMessages$ = state<ZeroChatMessage[]>([]);

  const resetLocalMessages$ = command(({ set }) => {
    set(internalLocalMessages$, []);
  });

  const chatMessages$ = computed(async (get): Promise<ChatMessages | null> => {
    const thread = await get(threadData$);
    if (!thread) {
      return null;
    }

    const { messages, activeRunMessages, lastActiveRunId } =
      transformServerMessages(thread.chatMessages);

    return {
      messages,
      activeRunMessages,
      agentId: thread.agentId,
      lastActiveRunId,
    };
  });

  const messages$ = computed(async (get) => {
    const msgs = await get(chatMessages$);
    const serverMessages = msgs?.messages ?? [];
    const localMessages = get(internalLocalMessages$);

    const serverRunIds = new Set(
      serverMessages
        .filter((m): m is AssistantChatMessage => {
          return m.role === "assistant" && !!m.legacyRunId;
        })
        .map((m) => {
          return m.legacyRunId;
        }),
    );

    const skipIndices = new Set<number>();
    for (let i = 0; i < localMessages.length; i++) {
      const m = localMessages[i];
      if (
        m.role === "assistant" &&
        m.legacyRunId &&
        serverRunIds.has(m.legacyRunId)
      ) {
        skipIndices.add(i);
        if (i > 0 && localMessages[i - 1].role === "user") {
          skipIndices.add(i - 1);
        }
      }
    }

    const filteredLocal = localMessages.filter((_, i) => {
      return !skipIndices.has(i);
    });
    const merged = [...serverMessages, ...filteredLocal];

    const last = filteredLocal[filteredLocal.length - 1];
    if (last?.role === "user") {
      merged.push(createPlaceholderAssistantMessage(last.id));
    }

    return merged;
  });

  const allFinished$ = computed(async (get) => {
    const msgs = await get(messages$);
    return (
      await Promise.all(
        msgs.map(async (message) => {
          if (message.role !== "assistant") {
            return true;
          }
          if (!message.runLoop) {
            return true;
          }
          return (await get(message.runLoop.finished$)) === true;
        }),
      )
    ).every(Boolean);
  });

  return {
    internalLocalMessages$,
    resetLocalMessages$,
    chatMessages$,
    messages$,
    allFinished$,
  };
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

// This is an internal scope used to maintain an internal message closure.
// This scope should only be used within the current file to help decouple specific creator factory command functions.
// This interface should never be exposed for external use.
interface MessageCommandsInternalScope {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  reloadThread$: Command<void, []>;
  internalLocalMessages$: ReturnType<typeof state<ZeroChatMessage[]>>;
  chatMessages$: Computed<Promise<ChatMessages | null>>;
  draft: DraftSignals;
  reloadThinkingMessage$: Command<void, []>;
  cancelDraftSync$: Command<void, []>;
  flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
  autoScroll$: Command<void, []>;
  scrollToBottom$: Command<void, []>;
}

function createPrepareUserMessage(draft: DraftSignals) {
  return command(
    async (
      { get },
      prompt: string,
      signal: AbortSignal,
    ): Promise<{
      fullPrompt: string;
      attachFiles: AttachFile[] | undefined;
      userMessage: UserChatMessage;
    } | null> => {
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

      // User prompt is clean text only — file download instructions go to systemPrompt.
      // When the user sends only files with no text, use a placeholder so the
      // contract's min(1) validation passes.
      const trimmedPrompt = prompt.trim();
      const fullPrompt =
        trimmedPrompt || (ready.length > 0 ? "(see attached files)" : "");

      const attachFiles: AttachFile[] | undefined =
        ready.length > 0
          ? ready.map((r) => {
              return {
                id: r.info.id,
                filename: r.attachment.filename,
                contentType: r.attachment.contentType,
                size: r.attachment.size,
              };
            })
          : undefined;

      const userMessage: UserChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: fullPrompt,
        attachments:
          ready.length > 0
            ? ready.map((r) => {
                return {
                  filename: r.attachment.filename,
                  contentType: r.attachment.contentType,
                  size: r.attachment.size,
                  url: r.info.url,
                };
              })
            : undefined,
      };
      return { fullPrompt, attachFiles, userMessage };
    },
  );
}

function createSendMessage(
  deps: MessageCommandsInternalScope,
  prepareUserMessage$: ReturnType<typeof createPrepareUserMessage>,
) {
  return command(async ({ get, set }, prompt: string, signal: AbortSignal) => {
    const thread = await get(deps.threadData$);
    signal.throwIfAborted();
    const agentId = thread?.agentId;
    if (!agentId) {
      return;
    }

    const result = await set(prepareUserMessage$, prompt, signal);
    if (!result) {
      return;
    }
    signal.throwIfAborted();

    set(deps.internalLocalMessages$, (prev) => {
      return [...prev, result.userMessage];
    });
    set(deps.cancelDraftSync$);
    set(deps.draft.clear$);
    await set(deps.flushDraftClear$, signal);
    signal.throwIfAborted();

    // Yield one microtask tick so React can flush the optimistic user message
    // into the DOM before we scroll. Without this the scroll fires against the
    // old layout and is effectively a no-op.
    await delay(0, { signal });
    set(deps.scrollToBottom$);

    const client = get(zeroClient$)(chatMessagesContract);
    const sendResult = await accept(
      client.send({
        body: {
          agentId,
          prompt: result.fullPrompt,
          threadId: deps.threadId,
          hasTextContent: prompt.trim().length > 0,
          attachFiles: result.attachFiles,
        },
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();

    set(reloadChatThreads$);
    set(deps.reloadThread$);

    const { assistantMessage } = createActiveRunMessage(
      sendResult.body.runId,
      prompt,
    );
    set(deps.internalLocalMessages$, (prev) => {
      return [...prev, assistantMessage];
    });

    set(markMessageLoading$, assistantMessage.legacyRunId!);

    const runLoop = assistantMessage.runLoop;
    if (!runLoop) {
      return;
    }

    const sendLoopBody$ = command(async ({ set }, sig: AbortSignal) => {
      set(reloadChatThreads$);
      set(deps.reloadThread$);
      const finished = await set(runLoop.checkFinished$, sig);
      set(deps.autoScroll$);
      return finished;
    });
    await set(
      setAblyLoop$,
      `thread:${sendResult.body.runId}`,
      sendLoopBody$,
      3000,
      signal,
    );

    // After the poll loop exits, the last `reloadThread$` ran at the START of
    // the final iteration — at that point the run's server-side status was
    // still "queued"/"running", so `transformServerMessages` picked the
    // assistant row as an active anchor and attached a fresh runLoop whose
    // `detail$` cached that stale status. Without one more reload, the
    // anchor's runLoop would stay stuck at the stale status, keeping
    // `MessageRunActivityLine` mounted — which renders the "Thinking..."
    // loader indefinitely whenever `summaries$` happens to be empty (notably
    // if the run only had tool_use events, or every tool_use was followed
    // by a text block so the final segment is empty).
    set(reloadChatThreads$);
    set(deps.reloadThread$);

    const content = await get(assistantMessage.result$);
    signal.throwIfAborted();
    if (content) {
      await set(checkAutoRead$, assistantMessage.legacyRunId!, content, signal);
    }
  });
}

function createLoadMessages(deps: MessageCommandsInternalScope) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    L.debug("Loading messages");
    const msgs = await get(deps.chatMessages$);
    signal.throwIfAborted();

    // Yield one microtask tick so React can flush the message list render into
    // the DOM before we trigger scrollToBottom$. Without this yield the scroll
    // container may still reflect the old layout and scrollToBottom$ would be
    // a no-op.
    await delay(0, { signal });
    set(deps.scrollToBottom$);

    if (!msgs?.activeRunMessages.length) {
      return;
    }

    set(deps.internalLocalMessages$, msgs.activeRunMessages);

    const assistantMessages = msgs.activeRunMessages.filter(
      (m): m is AssistantChatMessage => {
        return m.role === "assistant";
      },
    );

    if (assistantMessages.length === 0) {
      set(reloadChatThreads$);
      set(deps.reloadThread$);
      return;
    }

    await Promise.all(
      assistantMessages.map(async (message) => {
        const runLoop = message.runLoop;
        if (!runLoop?.checkFinished$) {
          return;
        }

        set(markMessageLoading$, message.legacyRunId!);

        const loadLoopBody$ = command(({ set }, sig: AbortSignal) => {
          set(deps.reloadThinkingMessage$);
          const finished = set(runLoop.checkFinished$, sig);
          set(deps.autoScroll$);
          return finished;
        });
        await set(
          setAblyLoop$,
          `thread:${message.legacyRunId}`,
          loadLoopBody$,
          3000,
          signal,
        );

        const content = await get(message.result$);
        signal.throwIfAborted();
        if (content) {
          await set(checkAutoRead$, message.legacyRunId!, content, signal);
        }

        set(reloadChatThreads$);
        set(deps.reloadThread$);
      }),
    );
    signal.throwIfAborted();
  });
}

function createMessageCommands(deps: MessageCommandsInternalScope) {
  const prepareUserMessage$ = createPrepareUserMessage(deps.draft);
  const sendMessage$ = createSendMessage(deps, prepareUserMessage$);
  const loadMessages$ = createLoadMessages(deps);

  const cancelRun$ = command(async ({ get, set }, signal: AbortSignal) => {
    const local = get(deps.internalLocalMessages$);
    const activeMsg = [...local]
      .reverse()
      .find((m): m is AssistantChatMessage => {
        return m.role === "assistant" && !!m.runLoop;
      });
    if (!activeMsg?.runLoop) {
      return;
    }
    await set(activeMsg.runLoop.cancel$, signal);
  });

  return { sendMessage$, loadMessages$, cancelRun$ };
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
// Factory
// ---------------------------------------------------------------------------

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

  /**
   * Debounced sync: waits 500ms, then reads the current draft state and PATCHes
   * the server. Aborted when `scheduleDraftSync$` is called again (debounce
   * reset) or when `cancelDraftSync$` fires (on send).
   */
  const debouncedSyncDraft$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      // Wait for the debounce window — abort if a newer change comes in.
      // The delay is configurable via setDraftSyncDebounceMs$ so tests can set it to 0.
      await delay(get(internalDraftSyncDebounceMs$), { signal });
      signal.throwIfAborted();

      const input = get(draft.input$);
      const content = input.trim() || null;
      const attachments = get(draft.attachments$);

      // Resolve attachment fileInfo to collect only completed uploads
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

  /**
   * Schedules a debounced draft sync. Each call aborts any prior in-flight
   * debounced sync and restarts the 500ms timer. Called from the draft change
   * watcher in setupChatPage$.
   */
  const scheduleDraftSync$ = command(({ set }, signal: AbortSignal) => {
    const debouncedSignal = set(draftSyncReset$, signal);
    // Start the debounced async sync. Abort errors are ignored (expected when
    // the signal is reset on the next draft change). Other errors surface via
    // accept()'s built-in toast error handling.
    void set(debouncedSyncDraft$, debouncedSignal).catch(throwIfNotAbort);
  });

  const cancelDraftSync$ = command(({ set }) => {
    // Abort the current debounced sync by resetting the signal
    set(draftSyncReset$);
  });

  const flushDraftClear$ = command(async ({ set }, signal: AbortSignal) => {
    // Cancel any pending debounced sync first
    set(draftSyncReset$);
    // Immediately PATCH null values
    await set(syncWithContent$, null, null, signal);
  });

  return { scheduleDraftSync$, cancelDraftSync$, flushDraftClear$ };
}

// ---------------------------------------------------------------------------
// Draft cache
// ---------------------------------------------------------------------------

/**
 * Per-thread draft cache. Drafts survive navigation (thread-1 -> thread-2 ->
 * thread-1) because they are stored here rather than inside the factory's
 * ephemeral signals.
 *
 * Wrapped in `state` to satisfy the ccstate/no-package-variable lint rule.
 * Updated immutably via `ensureDraft$` command — never mutated inside a
 * computed.
 */
const draftCache$ = state(new Map<string, DraftSignals>());

/**
 * Ensures a draft exists for the given threadId. If one already exists in the
 * cache, returns it. Otherwise creates a new one and immutably updates the
 * cache state.
 *
 * Returns `{ draft, isNew }` where `isNew` is true when a fresh draft was
 * created (i.e. this is the first visit to the thread in this session).
 * Callers can use `isNew` to decide whether to seed draft from server data.
 *
 * This is a command (not a plain function) so the cache mutation happens
 * outside of any computed derivation.
 */
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

export function createChatThreadSignals(
  threadId: string,
  draft: DraftSignals,
): ChatThreadSignals {
  const { threadData$, reloadThread$ } = createThreadData(threadId);
  const {
    internalLocalMessages$,
    resetLocalMessages$,
    messages$,
    chatMessages$,
    allFinished$,
  } = createMessageState(threadData$);
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

  const internalThinkingMessage$ = state(
    THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)],
  );
  const thinkingMessage$ = computed((get) => {
    return get(internalThinkingMessage$);
  });
  const reloadThinkingMessage$ = command(({ set }) => {
    set(
      internalThinkingMessage$,
      THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)],
    );
  });

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

  const { scheduleDraftSync$, cancelDraftSync$, flushDraftClear$ } =
    createDraftSync(threadId, draft);

  const { sendMessage$, loadMessages$, cancelRun$ } = createMessageCommands({
    threadId,
    threadData$,
    reloadThread$,
    internalLocalMessages$,
    chatMessages$,
    draft,
    reloadThinkingMessage$,
    cancelDraftSync$,
    flushDraftClear$,
    autoScroll$,
    scrollToBottom$,
  });

  return {
    threadData$,
    messages$,
    allFinished$,
    thinkingMessage$,
    loadMessages$,
    sendMessage$,
    cancelRun$,
    resetLocalMessages$,
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
  };
}

// ---------------------------------------------------------------------------
// Package-scope computed: derives ChatThreadSignals from the current route
// ---------------------------------------------------------------------------

/**
 * Singleton computed that produces ChatThreadSignals for the current
 * route's thread ID. ccstate memoizes the last result — if
 * `currentChatThreadId$` or `draftCache$` hasn't changed, the same
 * signals object is returned without re-creation.
 *
 * The draft for the current thread must be provisioned via `ensureDraft$`
 * before this computed is read (typically in `setupChatPage$`).
 */
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
