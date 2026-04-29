import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { animationFrame, delay } from "signal-timers";
import {
  createDeferredPromise,
  onRef,
  resetSignal,
  setLoop,
} from "../utils.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { createScrollSignals } from "../auto-scroll.ts";
import {
  createDraftSignals,
  type DraftSignals,
  type ZeroChatAttachment,
} from "../zero-page/chat-draft.ts";
import { prepareUserMessageFromDraft$ } from "./resolve-draft-attachments.ts";
import { reloadChatThreads$, type ChatThread } from "../agent-chat.ts";
import {
  chatMessagesContract,
  chatThreadArtifactsContract,
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  type ChatThreadArtifactRun,
  type ModelSelectionRequest,
  type PersistedAttachment,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroRunsCancelContract } from "@vm0/api-contracts/contracts/zero-runs";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { orgModelProviders$ } from "../external/org-model-providers.ts";
import { agentById } from "../agent.ts";
import { pinnedAgentIds$ } from "../zero-page/zero-pinned-agents.ts";
import {
  writeChatMessageToClipboard,
  type ChatClipboardPayload,
} from "../zero-page/clipboard.ts";
import type { GroupedChatMessageGroup } from "./chat-message.ts";
import { logger } from "../log.ts";

export type { DraftSignals } from "../zero-page/chat-draft.ts";

const L = logger("ChatThread");

// ---------------------------------------------------------------------------
// Thinking-indicator constants and helpers
// ---------------------------------------------------------------------------

const BLOCK_COLORS = [
  "#e8a0b4",
  "#c4705a",
  "#f5b88a",
  "#a8b560",
  "#6bb5a0",
  "#7baed4",
  "#b09eda",
  "#d4a87b",
  "#e07878",
  "#82c4c2",
] as const;

function shuffleBlockColors(): [string, string, string] {
  const shuffled = [...BLOCK_COLORS].sort(() => {
    return Math.random() - 0.5;
  });
  return [shuffled[0]!, shuffled[1]!, shuffled[2]!];
}

const THINKING_PHRASES = [
  "Brewing...",
  "Piecing together...",
  "Spinning up...",
  "On it...",
  "Assembling...",
  "Sketching out...",
  "Mapping it...",
  "Wiring up...",
  "Shaping...",
  "Tuning in...",
] as const;

const PHRASE_INTERVAL_MS = 3500;

const DONE_PHRASES = [
  (t: string) => {
    return `Wrapped up at ${t}`;
  },
  (t: string) => {
    return `All done — ${t}`;
  },
  (t: string) => {
    return `Delivered at ${t}`;
  },
  (t: string) => {
    return `Finished at ${t}, at your service`;
  },
  (t: string) => {
    return `That was a wrap — ${t}`;
  },
  (t: string) => {
    return `Mission complete, ${t}`;
  },
  (t: string) => {
    return `Signed off at ${t}`;
  },
  (t: string) => {
    return `Done and dusted — ${t}`;
  },
] as const;

function formatDonePhrase(lastMsg: PagedChatMessage | undefined): string {
  const time = lastMsg
    ? new Date(lastMsg.createdAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "just now";
  const pick = DONE_PHRASES[Math.floor(Math.random() * DONE_PHRASES.length)]!;
  return pick(time);
}

// ---------------------------------------------------------------------------
// ChatThreadSignals — returned by createChatThreadSignals
// ---------------------------------------------------------------------------

export interface ChatThreadSignals {
  threadId: string;
  // ── Data signals ──────────────────────────────────────────────────────────
  threadData$: Computed<Promise<ChatThread | null>>;
  // ── Composer model override ──────────────────────────────────────────────
  // Seeded from threadData$ on first resolve; user edits via setModelSelection$
  // take over and are preserved across subsequent threadData$ reloads.
  modelSelection$: Computed<Promise<ModelProviderSelection | null>>;
  setModelSelection$: Command<void, [ModelProviderSelection | null]>;
  sendMessage$: Command<
    Promise<void>,
    [string, ModelSelectionRequest | null, AbortSignal]
  >;
  cancelRun$: Command<Promise<void>, [AbortSignal]>;
  setScrollContainer$: Command<(() => void) | undefined, [HTMLElement | null]>;
  autoScroll$: Command<void, []>;
  scrollToBottom$: Command<void, []>;
  scrollToTop$: Command<void, []>;
  // ── Initial-load skeleton ────────────────────────────────────────────────
  // True until the page setup has fetched messages and scrolled into place.
  // Keeps the list mounted (visibility:hidden) while the skeleton covers the
  // viewport, so the first paint the user sees is already at the bottom.
  skeletonVisible$: Computed<boolean>;
  hideSkeleton$: Command<void, []>;
  draft: DraftSignals;
  composerFileInput$: Computed<HTMLElement | null>;
  setComposerFileInput$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  // ── Agent info (derived from threadData$.agentId) ─────────────────────────
  agentId$: Computed<Promise<string | null>>;
  agentDisplayName$: Computed<Promise<string | null>>;
  agentModelDefault$: Computed<Promise<ModelProviderSelection | null>>;
  agentPinned$: Computed<Promise<boolean | null>>;
  // ── Per-thread UI state ───────────────────────────────────────────────────
  timelineExpandedIds$: Computed<Set<string>>;
  toggleTimelineExpanded$: Command<void, [string]>;
  copiedMessageId$: Computed<string | null>;
  copyMessage$: Command<
    Promise<void>,
    [string, ChatClipboardPayload, AbortSignal]
  >;
  // ── Focus ─────────────────────────────────────────────────────────────────
  setInputRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  focusInput$: Command<void, []>;
  setRuntimeRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  // ── Draft sync ────────────────────────────────────────────────────────────
  scheduleDraftSync$: Command<Promise<void>, [AbortSignal]>;
  // ── Paged messages (sole rendering path) ─────────────────────────────────
  earliestChatMessageId$: Computed<Promise<string | undefined>>;
  latestChatMessageId$: Computed<Promise<string | undefined>>;
  groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>;
  hasOlderHistory$: Computed<Promise<boolean>>;
  latestRunStatus$: Computed<Promise<string | null>>;
  allFinished$: Computed<Promise<boolean>>;
  fetchNextPage$: Command<Promise<boolean>, [AbortSignal]>;
  loadHistory$: Command<Promise<void>, [AbortSignal]>;
  loadPagedMessages$: Command<Promise<void>, [AbortSignal]>;
  // ── Thinking indicator ───────────────────────────────────────────────────
  blockColors$: Computed<[string, string, string]>;
  rotatingPhrase$: Computed<string>;
  donePhrase$: Computed<string>;
  runPhraseLoop$: Command<Promise<void>, [AbortSignal]>;
  // ── Artifacts drawer ─────────────────────────────────────────────────────
  artifacts$: Computed<Promise<ChatThreadArtifactRun[]>>;
  artifactsDrawerOpen$: Computed<boolean>;
  setArtifactsDrawerOpen$: Command<void, [boolean]>;
  setArtifactsRealtimeRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  artifactPreviewKey$: Computed<string | null>;
  setArtifactPreviewKey$: Command<void, [string | null]>;
}

export interface LocalChatThreadSnapshot {
  threadData: ChatThread;
  messages: PagedChatMessage[];
  cancelRequested$: State<boolean>;
}

interface ChatThreadSignalOptions {
  localSnapshot?: LocalChatThreadSnapshot;
}

// ---------------------------------------------------------------------------
// Sub-factory: thread data fetching
// ---------------------------------------------------------------------------

// This per-thread `threadData$` is scoped to a single signal factory so it can
// be reloaded independently via `reloadThread$`. Keep the accept list aligned
// so missing-thread redirects and title merging both treat 404s the same way.
function createThreadData(
  threadId: string,
  options: ChatThreadSignalOptions = {},
) {
  const internalReload$ = state(0);

  const threadData$ = computed(async (get): Promise<ChatThread | null> => {
    get(internalReload$);
    if (options.localSnapshot) {
      return options.localSnapshot.threadData;
    }

    const threadClient = get(zeroClient$)(chatThreadByIdContract);
    const threadResult = await accept(
      threadClient.get({ params: { id: threadId } }),
      [200, 404],
      { toast: false },
    );
    if (threadResult.status === 404) {
      return null;
    }
    const body = threadResult.body;
    return {
      id: threadId,
      title: body.title ?? null,
      agentId: body.agentId,
      latestSessionId: body.latestSessionId ?? null,
      lastReadMessageId: body.lastReadMessageId ?? null,
      latestSessionProviderType: body.latestSessionProviderType ?? null,
      activeRunIds: body.activeRunIds,
      activeRuns: body.activeRuns ?? [],
      isLegacySession: false,
      draftContent: body.draftContent ?? null,
      draftAttachments: body.draftAttachments ?? null,
      modelProviderId: body.modelProviderId ?? null,
      selectedModel: body.selectedModel ?? null,
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
// Sub-factory: composer model override
// ---------------------------------------------------------------------------

function createModelSelection(
  threadData$: Computed<Promise<ChatThread | null>>,
) {
  // Discriminated union so we can tell "user hasn't picked anything yet" from
  // "user explicitly picked inherit (null)". Without the flag, clearing the
  // selection would be indistinguishable from the initial unset state and we'd
  // fall back to server data forever.
  const internalUserOverride$ = state<
    { kind: "unset" } | { kind: "set"; value: ModelProviderSelection | null }
  >({ kind: "unset" });

  const modelSelection$ = computed(
    async (get): Promise<ModelProviderSelection | null> => {
      const user = get(internalUserOverride$);
      if (user.kind === "set") {
        return user.value;
      }
      const thread = await get(threadData$);
      if (thread?.modelProviderId && thread.selectedModel) {
        return {
          modelProviderId: thread.modelProviderId,
          selectedModel: thread.selectedModel,
        };
      }
      // No thread override → fall back to the agent's default, then to the
      // org default. Seeding here (rather than letting the picker show its
      // null-value fallback) keeps the picker's displayed model identical
      // to what the send body carries. Without this seed, the backend
      // would receive `modelSelection: null` while the UI advertised a
      // specific model, producing a display/run mismatch.
      if (thread?.agentId) {
        const agent = await get(agentById(thread.agentId));
        if (agent?.modelProviderId && agent.selectedModel) {
          return {
            modelProviderId: agent.modelProviderId,
            selectedModel: agent.selectedModel,
          };
        }
      }
      const { modelProviders } = await get(orgModelProviders$);
      const defaultProvider = modelProviders.find((p) => {
        return p.isDefault;
      });
      if (defaultProvider?.selectedModel) {
        return {
          modelProviderId: defaultProvider.id,
          selectedModel: defaultProvider.selectedModel,
        };
      }
      return null;
    },
  );

  const setModelSelection$ = command(
    ({ set }, value: ModelProviderSelection | null) => {
      set(internalUserOverride$, { kind: "set", value });
    },
  );

  return { modelSelection$, setModelSelection$ };
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

  const agentModelDefault$ = computed(
    async (get): Promise<ModelProviderSelection | null> => {
      const agentId = await get(agentId$);
      if (!agentId) {
        return null;
      }
      const agent = await get(agentById(agentId));
      if (!agent?.modelProviderId || !agent.selectedModel) {
        return null;
      }
      return {
        modelProviderId: agent.modelProviderId,
        selectedModel: agent.selectedModel,
      };
    },
  );

  const agentPinned$ = computed(async (get): Promise<boolean | null> => {
    const agentId = await get(agentId$);
    if (!agentId) {
      return null;
    }
    const ids = await get(pinnedAgentIds$);
    return ids.includes(agentId);
  });

  return { agentId$, agentDisplayName$, agentModelDefault$, agentPinned$ };
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
      payload: ChatClipboardPayload,
      signal: AbortSignal,
    ) => {
      const ok = await writeChatMessageToClipboard(payload);
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

function createDraftSync(
  threadId: string,
  draft: DraftSignals,
  options: ChatThreadSignalOptions = {},
) {
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

  const scheduleDraftSync$ = command(async ({ set }, signal: AbortSignal) => {
    if (options.localSnapshot) {
      return;
    }
    const debouncedSignal = set(draftSyncReset$, signal);
    await set(debouncedSyncDraft$, debouncedSignal);
  });

  const cancelDraftSync$ = command(({ set }) => {
    set(draftSyncReset$);
  });

  const flushDraftClear$ = command(async ({ set }, signal: AbortSignal) => {
    if (options.localSnapshot) {
      return;
    }
    set(draftSyncReset$);
    await set(syncWithContent$, null, null, signal);
  });

  return { scheduleDraftSync$, cancelDraftSync$, flushDraftClear$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: paginated chat messages
// ---------------------------------------------------------------------------

/**
 * Merge new messages into existing groups.
 *
 * Upsert semantics by `id`: if an incoming message's id already exists in
 * the groups, its fields are replaced in place — this lets an optimistic
 * user row reconcile with the server-pushed row without React unmounting
 * and remounting the message (the React key stays the same).
 */
function mergeIntoGroups(
  groups: GroupedChatMessageGroup[],
  messages: PagedChatMessage[],
): GroupedChatMessageGroup[] {
  const result = groups.map((g) => {
    return { ...g, messages: [...g.messages] };
  });

  const positionById = new Map<string, { groupIdx: number; msgIdx: number }>();
  for (let gi = 0; gi < result.length; gi++) {
    const group = result[gi]!;
    for (let mi = 0; mi < group.messages.length; mi++) {
      positionById.set(group.messages[mi]!.id, { groupIdx: gi, msgIdx: mi });
    }
  }

  for (const msg of messages) {
    const existing = positionById.get(msg.id);
    if (existing) {
      result[existing.groupIdx]!.messages[existing.msgIdx] = msg;
      continue;
    }

    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      last.messages.push(msg);
      positionById.set(msg.id, {
        groupIdx: result.length - 1,
        msgIdx: last.messages.length - 1,
      });
    } else {
      result.push({
        beginMessageId: msg.id,
        role: msg.role,
        messages: [msg],
      });
      positionById.set(msg.id, { groupIdx: result.length - 1, msgIdx: 0 });
    }
  }
  return result;
}

type DeltaMessages$ = State<PagedChatMessage[]>;

function createAppendDelta(deltaMessages$: DeltaMessages$) {
  return command(({ set }, msgs: PagedChatMessage[]) => {
    if (msgs.length === 0) {
      return;
    }
    set(deltaMessages$, (prev) => {
      const byId = new Map<string, PagedChatMessage>();
      for (const m of prev) {
        byId.set(m.id, m);
      }
      let changed = false;
      for (const m of msgs) {
        const existing = byId.get(m.id);
        if (existing !== m) {
          byId.set(m.id, m);
          changed = true;
        }
      }
      return changed ? Array.from(byId.values()) : prev;
    });
  });
}

function createInitialPage$(
  threadId: string,
  threadData$: Computed<Promise<ChatThread | null>>,
  options: ChatThreadSignalOptions = {},
) {
  return computed(
    async (
      get,
    ): Promise<{
      messages: PagedChatMessage[];
      hasHistoryBefore: boolean;
    }> => {
      const thread = await get(threadData$);
      if (!thread) {
        return { messages: [], hasHistoryBefore: false };
      }
      if (options.localSnapshot) {
        return {
          messages: options.localSnapshot.messages,
          hasHistoryBefore: false,
        };
      }
      const client = get(zeroClient$)(chatThreadMessagesContract);
      const result = await accept(
        client.list({ params: { threadId }, query: { limit: 50 } }),
        [200],
      );
      const hasHistoryBefore = result.body.hasHistoryBefore ?? false;
      L.debug("initialPage$", {
        threadId,
        count: result.body.messages.length,
        hasHistoryBefore,
      });
      return {
        messages: result.body.messages,
        hasHistoryBefore,
      };
    },
  );
}

function createPagedMessages(
  threadId: string,
  threadData$: Computed<Promise<ChatThread | null>>,
  options: ChatThreadSignalOptions = {},
) {
  const loadedHistoryHasMore$ = state<boolean | null>(null);
  const historyMessages$ = state<PagedChatMessage[]>([]);
  const initialPage$ = createInitialPage$(threadId, threadData$, options);

  const deltaMessages$ = state<PagedChatMessage[]>([]);
  const appendDeltaMessages$ = createAppendDelta(deltaMessages$);

  const allMessages$ = computed(async (get): Promise<PagedChatMessage[]> => {
    const initial = await get(initialPage$);
    const history = get(historyMessages$);
    const deltas = get(deltaMessages$);
    return [...history, ...initial.messages, ...deltas];
  });

  const groupedChatMessages$ = computed(
    async (get): Promise<GroupedChatMessageGroup[]> => {
      return mergeIntoGroups([], await get(allMessages$));
    },
  );

  const earliestChatMessageId$ = computed(
    async (get): Promise<string | undefined> => {
      const messages = await get(allMessages$);
      return messages[0]?.id;
    },
  );

  const latestChatMessageId$ = computed(
    async (get): Promise<string | undefined> => {
      const messages = await get(allMessages$);
      return messages[messages.length - 1]?.id;
    },
  );

  const hasOlderHistory$ = computed(async (get): Promise<boolean> => {
    const loadedHistoryHasMore = get(loadedHistoryHasMore$);
    if (loadedHistoryHasMore !== null) {
      return loadedHistoryHasMore;
    }
    const initial = await get(initialPage$);
    return initial.hasHistoryBefore;
  });

  const fetchNextPage$ = command(async ({ get, set }, signal: AbortSignal) => {
    const thread = await get(threadData$);
    signal.throwIfAborted();
    if (!thread) {
      return true;
    }
    if (options.localSnapshot) {
      return true;
    }

    const sinceId = await get(latestChatMessageId$);
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
      return true;
    }
    set(appendDeltaMessages$, result.body.messages);
    return false;
  });

  const insertOptimisticMessage$ = command(({ set }, msg: PagedChatMessage) => {
    set(appendDeltaMessages$, [msg]);
  });

  const loadHistory$ = createLoadHistoryCommand({
    threadId,
    threadData$,
    earliestChatMessageId$,
    historyMessages$,
    loadedHistoryHasMore$,
    options,
  });

  return {
    earliestChatMessageId$,
    latestChatMessageId$,
    groupedChatMessages$,
    hasOlderHistory$,
    fetchNextPage$,
    loadHistory$,
    insertOptimisticMessage$,
  };
}

function createLoadHistoryCommand({
  threadId,
  threadData$,
  earliestChatMessageId$,
  historyMessages$,
  loadedHistoryHasMore$,
  options = {},
}: {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  earliestChatMessageId$: Computed<Promise<string | undefined>>;
  historyMessages$: State<PagedChatMessage[]>;
  loadedHistoryHasMore$: State<boolean | null>;
  options?: ChatThreadSignalOptions;
}): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const thread = await get(threadData$);
    signal.throwIfAborted();
    if (!thread) {
      set(loadedHistoryHasMore$, false);
      return;
    }
    if (options.localSnapshot) {
      set(loadedHistoryHasMore$, false);
      return;
    }

    const beforeId = await get(earliestChatMessageId$);
    signal.throwIfAborted();
    if (!beforeId) {
      set(loadedHistoryHasMore$, false);
      return;
    }

    const client = get(zeroClient$)(chatThreadMessagesContract);
    const result = await accept(
      client.list({
        params: { threadId },
        query: { beforeId, limit: 50 },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    set(historyMessages$, (prev) => {
      if (result.body.messages.length === 0) {
        return prev;
      }
      return [...result.body.messages, ...prev];
    });
    set(loadedHistoryHasMore$, result.body.hasHistoryBefore ?? false);
  });
}

function createArtifacts(
  threadId: string,
  groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>,
) {
  const internalArtifactsReload$ = state(0);
  const artifacts$ = computed(async (get): Promise<ChatThreadArtifactRun[]> => {
    await get(groupedChatMessages$);
    get(internalArtifactsReload$);
    const client = get(zeroClient$)(chatThreadArtifactsContract);
    const result = await accept(client.list({ params: { threadId } }), [200], {
      toast: false,
    });
    return result.body.runs;
  });

  const internalDrawerOpen$ = state(false);
  const artifactsDrawerOpen$ = computed((get) => {
    return get(internalDrawerOpen$);
  });
  const setArtifactsDrawerOpen$ = command(({ set }, open: boolean) => {
    if (open) {
      set(internalArtifactsReload$, (version) => {
        return version + 1;
      });
    }
    set(internalDrawerOpen$, open);
  });

  const reloadArtifactsFromRealtime$ = command(({ set }) => {
    set(internalArtifactsReload$, (version) => {
      return version + 1;
    });
    return false;
  });
  const setArtifactsRealtimeRef$ = onRef(
    command(async ({ set }, _el: HTMLElement, signal: AbortSignal) => {
      await set(
        setAblyLoop$,
        `chatThreadArtifactsChanged:${threadId}`,
        reloadArtifactsFromRealtime$,
        signal,
      );
    }),
  );

  const internalPreviewKey$ = state<string | null>(null);
  const artifactPreviewKey$ = computed((get) => {
    return get(internalPreviewKey$);
  });
  const setArtifactPreviewKey$ = command(({ set }, key: string | null) => {
    set(internalPreviewKey$, key);
  });

  return {
    artifacts$,
    artifactsDrawerOpen$,
    setArtifactsDrawerOpen$,
    setArtifactsRealtimeRef$,
    artifactPreviewKey$,
    setArtifactPreviewKey$,
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

function createSkeletonSignals() {
  const internalSkeletonVisible$ = state(true);
  const skeletonVisible$ = computed((get) => {
    return get(internalSkeletonVisible$);
  });
  const hideSkeleton$ = command(({ set }) => {
    set(internalSkeletonVisible$, false);
  });
  return { skeletonVisible$, hideSkeleton$ };
}

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

function createRuntimeRef({
  threadData$,
  groupedChatMessages$,
  hideSkeleton$,
  scrollToBottom$,
  runPhraseLoop$,
  loadPagedMessages$,
}: {
  threadData$: Computed<Promise<ChatThread | null>>;
  groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>;
  hideSkeleton$: Command<void, []>;
  scrollToBottom$: Command<void, []>;
  runPhraseLoop$: Command<Promise<void>, [AbortSignal]>;
  loadPagedMessages$: Command<Promise<void>, [AbortSignal]>;
}) {
  return onRef(
    command(async ({ get, set }, _el: HTMLElement, signal: AbortSignal) => {
      const threadData = await get(threadData$);
      signal.throwIfAborted();
      if (!threadData) {
        set(hideSkeleton$);
        return;
      }

      await get(groupedChatMessages$);
      signal.throwIfAborted();

      animationFrame(
        () => {
          set(scrollToBottom$);
          set(hideSkeleton$);
        },
        { signal },
      );

      await Promise.all([
        set(runPhraseLoop$, signal),
        set(loadPagedMessages$, signal),
      ]);
    }),
  );
}

function createLatestRunStatus(
  threadData$: Computed<Promise<ChatThread | null>>,
) {
  return computed(async (get): Promise<string | null> => {
    const thread = await get(threadData$);
    return thread?.activeRuns[0]?.status ?? null;
  });
}

function createLoadHistoryWithPrependScroll(
  recordScrollHeightForPrepend$: Command<void, []>,
  loadPagedHistory$: Command<Promise<void>, [AbortSignal]>,
) {
  return command(async ({ set }, signal: AbortSignal): Promise<void> => {
    set(recordScrollHeightForPrepend$);
    await set(loadPagedHistory$, signal);
  });
}

// ---------------------------------------------------------------------------
// Factory: createRunTracking
// ---------------------------------------------------------------------------

interface RunTrackingDeps {
  threadId: string;
  reloadThread$: Command<void, []>;
  threadData$: Computed<Promise<ChatThread | null>>;
  latestChatMessageId$: Computed<Promise<string | undefined>>;
  fetchNextPage$: Command<Promise<boolean>, [AbortSignal]>;
  autoScroll$: Command<void, []>;
  options: ChatThreadSignalOptions;
}

interface MarkThreadReadDeps {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  latestChatMessageId$: Computed<Promise<string | undefined>>;
  locallyMarkedReadMessageId$: State<string | undefined>;
}

function createMarkThreadReadIfNeeded({
  threadId,
  threadData$,
  latestChatMessageId$,
  locallyMarkedReadMessageId$,
}: MarkThreadReadDeps) {
  return command(async ({ get, set }, sig: AbortSignal) => {
    const latestMessageId = await get(latestChatMessageId$);
    sig.throwIfAborted();
    if (!latestMessageId) {
      return;
    }

    const thread = await get(threadData$);
    sig.throwIfAborted();
    const lastReadMessageId =
      get(locallyMarkedReadMessageId$) ?? thread?.lastReadMessageId ?? null;
    if (lastReadMessageId === latestMessageId) {
      return;
    }

    const client = get(zeroClient$)(chatThreadMarkReadContract);
    const result = await accept(
      client.markRead({
        params: { id: threadId },
        fetchOptions: { signal: sig },
      }),
      [200],
    );
    sig.throwIfAborted();
    set(
      locallyMarkedReadMessageId$,
      result.body.lastReadMessageId ?? latestMessageId,
    );
    // Server broadcasts `threadListChanged` via Ably on mark-read; the
    // sidebar reloads from that channel. Bumping reloadChatThreads$ here too
    // forces a redundant refetch that blocks subsequent keyboard navigation.
  });
}

function createRunTracking({
  threadId,
  reloadThread$,
  threadData$,
  latestChatMessageId$,
  fetchNextPage$,
  autoScroll$,
  options,
}: RunTrackingDeps) {
  const locallyMarkedReadMessageId$ = state<string | undefined>(undefined);

  const allFinished$ = computed(async (get) => {
    const cancelRequested = options.localSnapshot
      ? get(options.localSnapshot.cancelRequested$)
      : false;
    if (cancelRequested) {
      return true;
    }
    const thread = await get(threadData$);
    if (!thread) {
      return false;
    }
    return thread.activeRunIds.length === 0;
  });

  const markThreadReadIfNeeded$ = createMarkThreadReadIfNeeded({
    threadId,
    threadData$,
    latestChatMessageId$,
    locallyMarkedReadMessageId$,
  });

  const loadPagedMessages$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      const thread = await get(threadData$);
      signal.throwIfAborted();
      if (!thread) {
        throw new Error("invalid thread");
      }

      L.debug("loadPagedMessages$ start", {
        threadId,
        activeRunIds: thread.activeRunIds,
      });
      if (options.localSnapshot) {
        return;
      }

      // Mark thread as read on open (focus-gated)
      if (document.visibilityState !== "visible") {
        const visibleDeferred = createDeferredPromise<void>(signal);
        const handler = () => {
          if (document.visibilityState === "visible") {
            visibleDeferred.resolve();
          }
        };
        document.addEventListener("visibilitychange", handler, {
          signal,
        });
        await visibleDeferred.promise;
        signal.throwIfAborted();
      }
      await set(markThreadReadIfNeeded$, signal);

      const onMessageCreated$ = command(async ({ set }, sig: AbortSignal) => {
        await set(fetchNextPage$, sig);
        // Advance read marker when a new message arrives while focused.
        if (document.visibilityState === "visible") {
          await set(markThreadReadIfNeeded$, sig);
        }
        animationFrame(
          () => {
            set(autoScroll$);
          },
          { signal },
        );
        return false;
      });

      const onRunChanged$ = command(({ set }) => {
        set(reloadThread$);
        return false;
      });

      // `chatThreadReadCursorUpdated:<id>` used to bump `patchThreadRead$`
      // here; dropped because `threadListChanged` already fans out to the
      // sidebar, and the extra reload blocks keyboard navigation.

      await Promise.all([
        set(
          setAblyLoop$,
          `chatThreadMessageCreated:${threadId}`,
          onMessageCreated$,
          signal,
        ),
        set(
          setAblyLoop$,
          `chatThreadRunCreated:${thread.id}`,
          onRunChanged$,
          signal,
        ),
        set(
          setAblyLoop$,
          `chatThreadRunUpdated:${thread.id}`,
          onRunChanged$,
          signal,
        ),
      ]);

      signal.throwIfAborted();
    },
  );

  const cancelRun$ = command(async ({ get, set }, signal: AbortSignal) => {
    if (options.localSnapshot) {
      set(options.localSnapshot.cancelRequested$, true);
      return;
    }
    const thread = await get(threadData$);
    signal.throwIfAborted();
    if (!thread) {
      return;
    }
    const client = get(zeroClient$)(zeroRunsCancelContract);
    const before = thread.activeRunIds;
    L.debug("cancelRun$ start", { threadId, pendingRunIds: before });

    await Promise.all(
      before.map(async (runId) => {
        await accept(
          client.cancel({ params: { id: runId }, fetchOptions: { signal } }),
          [200],
        );
        L.debug("cancelRun$ server accepted cancel", { threadId, runId });
      }),
    );
    signal.throwIfAborted();
  });

  return { allFinished$, loadPagedMessages$, cancelRun$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: sendMessage command
// ---------------------------------------------------------------------------

interface SendMessageDeps {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  draft: DraftSignals;
  cancelDraftSync$: Command<void, []>;
  flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
  insertOptimisticMessage$: Command<void, [PagedChatMessage]>;
  scrollToBottom$: Command<void, []>;
}

function createSendMessage(deps: SendMessageDeps) {
  const {
    threadId,
    threadData$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    insertOptimisticMessage$,
    scrollToBottom$,
  } = deps;
  const sendMessage$ = command(
    async (
      { get, set },
      prompt: string,
      modelSelection: ModelSelectionRequest | null,
      signal: AbortSignal,
    ) => {
      L.debug("sendMessage$ start", { threadId, promptLen: prompt.length });
      const thread = await get(threadData$);
      signal.throwIfAborted();
      const agentId = thread?.agentId;
      if (!agentId) {
        L.debug("sendMessage$ no agentId, abort", { threadId });
        return;
      }

      const result = await set(
        prepareUserMessageFromDraft$,
        draft,
        prompt,
        signal,
      );
      if (!result) {
        L.debug("sendMessage$ prepare returned null, abort", { threadId });
        return;
      }
      signal.throwIfAborted();

      set(cancelDraftSync$);
      set(draft.clear$);

      const clientMessageId = crypto.randomUUID();
      set(insertOptimisticMessage$, {
        id: clientMessageId,
        role: "user",
        content: result.prompt,
        attachFiles: result.attachments,
        createdAt: new Date().toISOString(),
      });
      animationFrame(
        () => {
          set(scrollToBottom$);
        },
        { signal },
      );

      const client = get(zeroClient$)(chatMessagesContract);
      const [, sendResult] = await Promise.all([
        set(flushDraftClear$, signal),
        accept(
          client.send({
            body: {
              agentId,
              prompt: result.prompt,
              threadId: threadId,
              hasTextContent: result.hasTextContent,
              clientMessageId,
              modelSelection,
              attachFiles: result.attachFiles,
            },
            fetchOptions: { signal },
          }),
          [201],
        ),
      ]);
      signal.throwIfAborted();

      L.debug("sendMessage$ POST accepted", {
        threadId,
        runId: sendResult.body.runId,
      });

      set(reloadChatThreads$);
      L.debug("sendMessage$ done", {
        threadId,
        runId: sendResult.body.runId,
      });
    },
  );
  return { sendMessage$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: thinking phrase animation
// ---------------------------------------------------------------------------

function createPhraseLoop(
  groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>,
  allFinished$: Computed<Promise<boolean>>,
) {
  const internalBlockColors$ =
    state<[string, string, string]>(shuffleBlockColors());
  const blockColors$ = computed((get) => {
    return get(internalBlockColors$);
  });
  const phraseIndex$ = state(
    Math.floor(Math.random() * THINKING_PHRASES.length),
  );
  const rotatingPhrase$ = computed((get) => {
    return THINKING_PHRASES[get(phraseIndex$)]!;
  });
  const internalDonePhrase$ = state<string>(formatDonePhrase(undefined));
  const donePhrase$ = computed((get) => {
    return get(internalDonePhrase$);
  });
  const lastDoneMessageId$ = state<string | undefined>(undefined);

  const runPhraseLoop$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      await setLoop(
        async (sig) => {
          const groups = await get(groupedChatMessages$);
          sig.throwIfAborted();
          const lastGroup = groups[groups.length - 1];
          const lastIsAssistant = lastGroup?.role === "assistant";
          const lastMsg =
            lastIsAssistant && lastGroup
              ? lastGroup.messages[lastGroup.messages.length - 1]
              : undefined;
          if (lastMsg?.id !== get(lastDoneMessageId$)) {
            set(lastDoneMessageId$, lastMsg?.id);
            set(internalDonePhrase$, formatDonePhrase(lastMsg));
          }
          const allFinished = await get(allFinished$);
          sig.throwIfAborted();
          if (!allFinished || (!!lastGroup && !lastIsAssistant)) {
            set(
              phraseIndex$,
              (get(phraseIndex$) + 1) % THINKING_PHRASES.length,
            );
          }
          return false;
        },
        PHRASE_INTERVAL_MS,
        signal,
      );
    },
  );

  return { blockColors$, rotatingPhrase$, donePhrase$, runPhraseLoop$ };
}

// ---------------------------------------------------------------------------
// Factory: createChatThreadSignals
// ---------------------------------------------------------------------------

export function createChatThreadSignals(
  threadId: string,
  draft: DraftSignals,
  options: ChatThreadSignalOptions = {},
): ChatThreadSignals {
  const { threadData$, reloadThread$ } = createThreadData(threadId, options);
  const { modelSelection$, setModelSelection$ } =
    createModelSelection(threadData$);
  const {
    setScrollContainer$,
    autoScroll$,
    scrollToBottom$,
    scrollToTop$,
    recordScrollHeightForPrepend$,
  } = createScrollSignals(threadId);
  const { skeletonVisible$, hideSkeleton$ } = createSkeletonSignals();
  const { composerFileInput$, setComposerFileInput$ } =
    createComposerFileInput();
  const { agentId$, agentDisplayName$, agentModelDefault$, agentPinned$ } =
    createAgentInfoSignals(threadData$);
  const {
    timelineExpandedIds$,
    toggleTimelineExpanded$,
    copiedMessageId$,
    copyMessage$,
  } = createThreadUIState();
  const {
    earliestChatMessageId$,
    latestChatMessageId$,
    groupedChatMessages$,
    hasOlderHistory$,
    fetchNextPage$,
    loadHistory$: loadPagedHistory$,
    insertOptimisticMessage$,
  } = createPagedMessages(threadId, threadData$, options);

  const loadHistory$ = createLoadHistoryWithPrependScroll(
    recordScrollHeightForPrepend$,
    loadPagedHistory$,
  );

  const { scheduleDraftSync$, cancelDraftSync$, flushDraftClear$ } =
    createDraftSync(threadId, draft, options);
  const { allFinished$, loadPagedMessages$, cancelRun$ } = createRunTracking({
    threadId,
    reloadThread$,
    threadData$,
    latestChatMessageId$,
    fetchNextPage$,
    autoScroll$,
    options,
  });

  const { sendMessage$ } = createSendMessage({
    threadId,
    threadData$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    insertOptimisticMessage$,
    scrollToBottom$,
  });

  const { setInputRef$, focusInput$ } = createInputRef();
  const { blockColors$, rotatingPhrase$, donePhrase$, runPhraseLoop$ } =
    createPhraseLoop(groupedChatMessages$, allFinished$);
  const {
    artifacts$,
    artifactsDrawerOpen$,
    setArtifactsDrawerOpen$,
    setArtifactsRealtimeRef$,
    artifactPreviewKey$,
    setArtifactPreviewKey$,
  } = createArtifacts(threadId, groupedChatMessages$);

  const latestRunStatus$ = createLatestRunStatus(threadData$);
  const setRuntimeRef$ = createRuntimeRef({
    threadData$,
    groupedChatMessages$,
    hideSkeleton$,
    scrollToBottom$,
    runPhraseLoop$,
    loadPagedMessages$,
  });

  return {
    threadId,
    threadData$,
    modelSelection$,
    setModelSelection$,
    sendMessage$,
    cancelRun$,
    setScrollContainer$,
    autoScroll$,
    scrollToBottom$,
    scrollToTop$,
    skeletonVisible$,
    hideSkeleton$,
    draft,
    composerFileInput$,
    setComposerFileInput$,
    agentId$,
    agentDisplayName$,
    agentModelDefault$,
    agentPinned$,
    timelineExpandedIds$,
    toggleTimelineExpanded$,
    copiedMessageId$,
    copyMessage$,
    setInputRef$,
    focusInput$,
    setRuntimeRef$,
    scheduleDraftSync$,
    earliestChatMessageId$,
    latestChatMessageId$,
    groupedChatMessages$,
    hasOlderHistory$,
    latestRunStatus$,
    allFinished$,
    fetchNextPage$,
    loadHistory$,
    loadPagedMessages$,
    blockColors$,
    rotatingPhrase$,
    donePhrase$,
    runPhraseLoop$,
    artifacts$,
    artifactsDrawerOpen$,
    setArtifactsDrawerOpen$,
    setArtifactsRealtimeRef$,
    artifactPreviewKey$,
    setArtifactPreviewKey$,
  };
}
