import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef, setLoop } from "../utils.ts";
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
import { chatMessagesContract, chatThreadByIdContract } from "@vm0/core";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { agentById } from "../agent.ts";
import { pinnedAgentIds$ } from "../zero-page/zero-pinned-agents.ts";
import { writeToClipboard } from "../zero-page/clipboard.ts";
import {
  createActiveRunMessage,
  unsavedRunsToMessages,
  createPlaceholderAssistantMessage,
  transformServerMessages,
  THINKING_MESSAGES,
  type ChatMessages,
  type ZeroChatMessage,
  type UserChatMessage,
  type AssistantChatMessage,
} from "./chat-message.ts";

export type { DraftSignals } from "../zero-page/chat-draft.ts";

const L = logger("ChatThread");

// ---------------------------------------------------------------------------
// ChatThreadSignals — returned by createChatThreadSignals
// ---------------------------------------------------------------------------

export interface ChatThreadSignals {
  // ── Data signals ──────────────────────────────────────────────────────────
  threadData$: Computed<Promise<ChatThread | null>>;
  reloadThread$: Command<void, []>;
  messages$: Computed<Promise<ZeroChatMessage[]>>;
  allFinished$: Computed<Promise<boolean>>;
  thinkingMessage$: Computed<string>;
  loadMessages$: Command<Promise<void>, [AbortSignal]>;
  sendMessage$: Command<Promise<void>, [string, AbortSignal]>;
  cancelRun$: Command<Promise<void>, [AbortSignal]>;
  resetLocalMessages$: Command<void, []>;
  setScrollContainer$: Command<void, [HTMLElement | null]>;
  autoScroll$: Command<void, []>;
  forceScrollToBottom$: Command<void, []>;
  draft: DraftSignals;
  composerFileInput$: Computed<HTMLElement | null>;
  setComposerFileInput$: Command<void, [HTMLElement | null]>;
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
      unsavedRuns: body.unsavedRuns ?? [],
      isLegacySession: false,
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

  const currentChatMessages$ = computed(
    async (get): Promise<ZeroChatMessage[]> => {
      const messages = (await get(threadData$))?.chatMessages ?? [];
      return transformServerMessages(messages);
    },
  );

  const chatMessages$ = computed(async (get): Promise<ChatMessages | null> => {
    const thread = await get(threadData$);
    if (!thread) {
      return null;
    }
    const {
      messages: runMessages,
      activeRunMessages,
      lastActiveRunId: legacyLastActiveRunId,
    } = unsavedRunsToMessages(thread.unsavedRuns);

    const allMessages = [...(await get(currentChatMessages$)), ...runMessages];
    allMessages.sort((a, b) => {
      const aTime = a.createdAt ?? "";
      const bTime = b.createdAt ?? "";
      return aTime.localeCompare(bTime);
    });

    return {
      messages: allMessages,
      activeRunMessages,
      agentId: thread.agentId,
      lastActiveRunId: legacyLastActiveRunId,
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
// Sub-factory: scroll
// ---------------------------------------------------------------------------

const NEAR_BOTTOM_THRESHOLD = 80;

function scrollToMessages(scrollEl: HTMLElement) {
  const container = scrollEl.querySelector<HTMLElement>(
    "[data-message-container]",
  );
  if (!container || container.children.length === 0) {
    return;
  }

  let lastUser: HTMLElement | null = null;
  let lastAssistant: HTMLElement | null = null;
  for (let i = container.children.length - 1; i >= 0; i--) {
    const child = container.children[i];
    if (!(child instanceof HTMLElement)) {
      continue;
    }
    const role = child.dataset.role;
    if (!lastAssistant && role === "assistant") {
      lastAssistant = child;
    }
    if (!lastUser && role === "user") {
      lastUser = child;
    }
    if (lastUser && lastAssistant) {
      break;
    }
  }

  if (!lastUser) {
    return;
  }

  const composer = scrollEl.querySelector<HTMLElement>("[data-chat-composer]");
  const composerHeight = composer ? composer.offsetHeight : 0;
  const visibleHeight = scrollEl.clientHeight - composerHeight;
  const userTop = lastUser.offsetTop - container.offsetTop;

  if (lastAssistant && lastAssistant.offsetTop > lastUser.offsetTop) {
    const assistantBottom =
      lastAssistant.offsetTop -
      container.offsetTop +
      lastAssistant.offsetHeight;
    if (assistantBottom - userTop <= visibleHeight) {
      scrollEl.scrollTop = userTop;
    } else {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  } else {
    scrollEl.scrollTop = userTop;
  }
}

function createScrollSignals() {
  const internalScrollContainer$ = state<HTMLElement | null>(null);

  const setScrollContainer$ = command(({ set }, el: HTMLElement | null) => {
    set(internalScrollContainer$, el);
  });

  const forceScrollToBottom$ = command(({ get }) => {
    const scrollEl = get(internalScrollContainer$);
    if (!scrollEl) {
      return;
    }
    scrollToMessages(scrollEl);
  });

  const autoScroll$ = command(({ get }) => {
    const scrollEl = get(internalScrollContainer$);
    if (!scrollEl) {
      return;
    }
    const distanceFromBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    if (distanceFromBottom > NEAR_BOTTOM_THRESHOLD) {
      return;
    }
    scrollToMessages(scrollEl);
  });

  return { setScrollContainer$, autoScroll$, forceScrollToBottom$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: composer file input
// ---------------------------------------------------------------------------

function createComposerFileInput() {
  const internal$ = state<HTMLElement | null>(null);
  const composerFileInput$ = computed((get) => {
    return get(internal$);
  });
  const setComposerFileInput$ = command(({ set }, el: HTMLElement | null) => {
    set(internal$, el);
  });
  return { composerFileInput$, setComposerFileInput$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: message commands (send, load, cancel)
// ---------------------------------------------------------------------------

interface MessageCommandsDeps {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  reloadThread$: Command<void, []>;
  internalLocalMessages$: ReturnType<typeof state<ZeroChatMessage[]>>;
  chatMessages$: Computed<Promise<ChatMessages | null>>;
  draft: DraftSignals;
  reloadThinkingMessage$: Command<void, []>;
}

function createPrepareUserMessage(deps: MessageCommandsDeps) {
  return command(
    async (
      { get, set },
      prompt: string,
      signal: AbortSignal,
    ): Promise<{ fullPrompt: string } | null> => {
      const allAttachments = get(deps.draft.attachments$);
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

      const userMessage: UserChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: prompt.trim(),
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
      set(deps.internalLocalMessages$, (prev) => {
        return [...prev, userMessage];
      });
      set(deps.draft.clear$);
      return { fullPrompt };
    },
  );
}

function createMessageCommands(deps: MessageCommandsDeps) {
  const prepareUserMessage$ = createPrepareUserMessage(deps);

  const sendMessage$ = command(
    async ({ get, set }, prompt: string, signal: AbortSignal) => {
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

      const client = get(zeroClient$)(chatMessagesContract);
      const sendResult = await accept(
        client.send({
          body: {
            agentId,
            prompt: result.fullPrompt,
            threadId: deps.threadId,
            hasTextContent: prompt.trim().length > 0,
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

      const runLoop = assistantMessage.runLoop;
      if (!runLoop) {
        return;
      }

      await setLoop(
        (sig) => {
          set(reloadChatThreads$);
          set(deps.reloadThread$);
          return set(runLoop.checkFinished$, sig);
        },
        3000,
        signal,
      );
    },
  );

  const loadMessages$ = command(async ({ get, set }, signal: AbortSignal) => {
    L.debug("Loading messages");
    const msgs = await get(deps.chatMessages$);
    signal.throwIfAborted();
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

        await setLoop(
          (sig) => {
            set(deps.reloadThinkingMessage$);
            return set(runLoop.checkFinished$, sig);
          },
          3000,
          signal,
        );

        set(reloadChatThreads$);
        set(deps.reloadThread$);
      }),
    );
    signal.throwIfAborted();
  });

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
 * This is a command (not a plain function) so the cache mutation happens
 * outside of any computed derivation.
 */
export const ensureDraft$ = command(({ get, set }, threadId: string) => {
  const cache = get(draftCache$);
  const existing = cache.get(threadId);
  if (existing) {
    return existing;
  }
  const draft = createDraftSignals();
  const next = new Map(cache);
  next.set(threadId, draft);
  set(draftCache$, next);
  return draft;
});

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
  const { setScrollContainer$, autoScroll$, forceScrollToBottom$ } =
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

  const { sendMessage$, loadMessages$, cancelRun$ } = createMessageCommands({
    threadId,
    threadData$,
    reloadThread$,
    internalLocalMessages$,
    chatMessages$,
    draft,
    reloadThinkingMessage$,
  });

  return {
    threadData$,
    reloadThread$,
    messages$,
    allFinished$,
    thinkingMessage$,
    loadMessages$,
    sendMessage$,
    cancelRun$,
    resetLocalMessages$,
    setScrollContainer$,
    autoScroll$,
    forceScrollToBottom$,
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
