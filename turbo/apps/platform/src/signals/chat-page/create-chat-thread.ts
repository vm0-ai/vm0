import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { animationFrame, delay } from "signal-timers";
import { onRef, resetSignal, setLoop } from "../utils.ts";
import { setAblyLoop$ } from "../realtime.ts";
import {
  createScrollSignals,
  type ScrollStepDirection,
} from "../auto-scroll.ts";
import {
  createDraftSignals,
  createRestoredAttachment,
  type DraftSignals,
} from "../zero-page/chat-draft.ts";
import {
  collectSuccessfulAttachmentInfos,
  prepareUserMessageFromDraft$,
  shouldExcludeVisualAttachmentsForModel,
} from "./resolve-draft-attachments.ts";
import { reloadChatThreads$, type ChatThread } from "../agent-chat.ts";
import {
  chatMessagesContract,
  chatThreadArtifactsContract,
  type ChatThreadArtifactRun,
  type ModelSelectionRequest,
  type PagedChatMessage,
  type PendingMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { agentById } from "../agent.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { pinnedAgentIds$ } from "../zero-page/zero-pinned-agents.ts";
import { composerModelProviders$ } from "../zero-page/composer-model-providers.ts";
import { resolveEffectiveAgentDefaultSelection } from "../zero-page/model-provider-default.ts";
import {
  writeChatMessageToClipboard,
  type ChatClipboardPayload,
} from "../zero-page/clipboard.ts";
import type {
  EnrichedChatMessage,
  GroupedChatMessageGroup,
} from "./chat-message.ts";
import { logger } from "../log.ts";
import type { ChatThreadDataSource } from "./chat-thread-data-source.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import {
  enrichBlocksWithTextPreviews,
  parseBodyRenderBlocks,
} from "./parse-body-blocks.ts";
import { clerk$ } from "../auth.ts";
import {
  patchThreadMeta$,
  readThreadMeta$,
} from "../external/idb-thread-meta-store.ts";

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
  queueMessage$: Command<Promise<void>, [string, AbortSignal]>;
  recallPendingMessage$: Command<Promise<void>, [AbortSignal]>;
  // View-side pending message — masks the server value the moment the user
  // recalls it so the queued card disappears synchronously, without waiting
  // for the fire-and-forget server clear to round-trip.
  pendingMessage$: Computed<Promise<PendingMessage | null>>;
  // True when the rendered pending message is the optimistic, client-only
  // bubble that hasn't been confirmed by the server yet. Used by the queued
  // row to render the Recall button in a disabled state during this window.
  pendingMessageIsOptimistic$: Computed<Promise<boolean>>;
  cancelRun$: Command<Promise<void>, [AbortSignal]>;
  setScrollContainer$: Command<(() => void) | undefined, [HTMLElement | null]>;
  autoScroll$: Command<void, []>;
  scrollToBottom$: Command<void, []>;
  scrollToTop$: Command<void, []>;
  scrollBy$: Command<boolean, [ScrollStepDirection]>;
  prepareKeyboardScroll$: Command<boolean, []>;
  // ── Initial-load skeleton ────────────────────────────────────────────────
  // Starts hidden — `setupChatThreadInitScroll$` flips it on only when the
  // IDB cache misses, so cache hits skip the skeleton entirely. Flipped off
  // once messages resolve and the viewport is scrolled into place.
  skeletonVisible$: Computed<boolean>;
  showSkeleton$: Command<void, []>;
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
  subscribeChatThread$: Command<Promise<void>, [AbortSignal]>;
  insertOptimisticMessage$: Command<void, [PagedChatMessage]>;
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

// ---------------------------------------------------------------------------
// Sub-factory: thread data fetching
// ---------------------------------------------------------------------------

// The data source owns both `getThread$` (the resolved thread) and
// `reloadThread$` (the invalidation lever). Local mode never reloads;
// remote mode bumps an internal counter on its `getThread$` computed.
function createThreadData(dataSource: ChatThreadDataSource) {
  return {
    threadData$: dataSource.getThread$,
    reloadThread$: dataSource.reloadThread$,
  };
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
      // No thread override → fall back to preferred personal default, then
      // the agent's default, then the workspace default. Seeding here
      // (rather than letting the picker show its null-value fallback) keeps
      // the picker's displayed model identical to what the send body carries.
      // Without this seed, the backend would receive `modelSelection: null`
      // while the UI advertised a specific model, producing a display/run
      // mismatch.
      const agent = thread?.agentId
        ? await get(agentById(thread.agentId))
        : null;
      const composerProviders = await get(composerModelProviders$);
      return resolveEffectiveAgentDefaultSelection({
        agent,
        providers: composerProviders.providers,
        tiers: composerProviders.tiers,
      });
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
  threadId: string,
  threadData$: Computed<Promise<ChatThread | null>>,
) {
  // agentId$ is read by avatar / pinned / model-default UI on first paint.
  // Resolving it via threadData$ blocks the avatar render on the
  // chat-threads/:id round-trip, even though the agentId rarely changes
  // for a given thread. Consult the IDB cache first; on miss, fall back
  // to threadData$ and backfill so the next visit hits the cache.
  const agentId$ = computed(async (get): Promise<string | null> => {
    const clerk = await get(clerk$);
    const userId = clerk?.user?.id ?? null;
    const orgId = clerk?.organization?.id ?? null;

    if (userId !== null && orgId !== null) {
      const meta = await readThreadMeta$(userId, orgId, threadId);
      if (meta?.agentId) {
        return meta.agentId;
      }
    }
    const thread = await get(threadData$);
    const agentId = thread?.agentId ?? null;
    if (agentId && userId !== null && orgId !== null) {
      await patchThreadMeta$(userId, orgId, threadId, { agentId });
    }
    return agentId;
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
      const composerProviders = await get(composerModelProviders$);
      return resolveEffectiveAgentDefaultSelection({
        agent,
        providers: composerProviders.providers,
        tiers: composerProviders.tiers,
      });
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
  dataSource: ChatThreadDataSource,
) {
  // A reset signal is used to abort any in-flight debounced sync when a new
  // change comes in or when the draft is cleared on send.
  const draftSyncReset$ = resetSignal();

  const debouncedSyncDraft$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      await delay(get(internalDraftSyncDebounceMs$), { signal });
      signal.throwIfAborted();

      const input = get(draft.input$);
      const content = input.trim() || null;
      const attachments = get(draft.attachments$);

      const infos = await Promise.allSettled(
        attachments.map((a) => {
          return get(a.fileInfo$);
        }),
      );
      signal.throwIfAborted();
      const persisted = collectSuccessfulAttachmentInfos(
        attachments,
        infos,
      ).map((r) => {
        return {
          id: r.info.id,
          url: r.info.url,
          filename: r.attachment.filename,
          contentType: r.attachment.contentType,
          size: r.attachment.size,
        };
      });

      await set(
        dataSource.patchDraft$,
        {
          threadId,
          content,
          attachments: persisted.length > 0 ? persisted : null,
        },
        signal,
      );
    },
  );

  const scheduleDraftSync$ = command(async ({ set }, signal: AbortSignal) => {
    const debouncedSignal = set(draftSyncReset$, signal);
    await set(debouncedSyncDraft$, debouncedSignal);
  });

  const cancelDraftSync$ = command(({ set }) => {
    set(draftSyncReset$);
  });

  const flushDraftClear$ = command(async ({ set }, signal: AbortSignal) => {
    set(draftSyncReset$);
    await set(
      dataSource.patchDraft$,
      { threadId, content: null, attachments: null },
      signal,
    );
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
  messages: EnrichedChatMessage[],
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

function createInitialPage(dataSource: ChatThreadDataSource) {
  return dataSource.initialPage$;
}

function createPagedMessages(
  threadId: string,
  threadData$: Computed<Promise<ChatThread | null>>,
  dataSource: ChatThreadDataSource,
) {
  const loadedHistoryHasMore$ = state<boolean | null>(null);
  const historyMessages$ = state<PagedChatMessage[]>([]);
  const initialPage$ = createInitialPage(dataSource);

  const deltaMessages$ = state<PagedChatMessage[]>([]);
  const appendDeltaMessages$ = createAppendDelta(deltaMessages$);

  // Tracks the last known server-validated message ID so optimistic
  // (client-generated) IDs never leak into sinceId calls.
  // Lazy-init from initialPage$ on first fetchNextPage$ call, then
  // advanced after each successful fetch to the last returned message.
  const nextCursorId$ = state<string | undefined>(undefined);

  const allMessages$ = computed(async (get): Promise<EnrichedChatMessage[]> => {
    const initial = await get(initialPage$);
    const history = get(historyMessages$);
    const deltas = get(deltaMessages$);
    const raw = [...history, ...initial.messages, ...deltas];
    return raw.map((msg) => {
      const { blocks } = parseBodyRenderBlocks(msg.content ?? "");
      return { ...msg, blocks: enrichBlocksWithTextPreviews(blocks) };
    });
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
    let sinceId = get(nextCursorId$);
    if (!sinceId) {
      const initial = await get(initialPage$);
      signal.throwIfAborted();
      sinceId = initial.messages[initial.messages.length - 1]?.id;
      if (sinceId) {
        set(nextCursorId$, sinceId);
      }
    }
    signal.throwIfAborted();
    if (!sinceId) {
      return true;
    }
    // Drain all pending pages so a single trigger fully catches the client
    // up.  Without this loop, one Ably event or visibilitychange fetches at
    // most 50 messages then stops; a burst larger than one page leaves the
    // client permanently behind if the thread goes quiet afterward.
    const MAX_PAGES = 10;
    for (let i = 0; i < MAX_PAGES; i++) {
      const result: { messages: PagedChatMessage[]; reachedEnd: boolean } =
        await set(dataSource.listMessagesAfter$, { threadId, sinceId }, signal);
      signal.throwIfAborted();
      if (result.messages.length > 0) {
        set(appendDeltaMessages$, result.messages);
        sinceId = result.messages[result.messages.length - 1].id;
        set(nextCursorId$, sinceId);
      }
      if (result.reachedEnd) {
        return true;
      }
    }
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
    dataSource,
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
  dataSource,
}: {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  earliestChatMessageId$: Computed<Promise<string | undefined>>;
  historyMessages$: State<PagedChatMessage[]>;
  loadedHistoryHasMore$: State<boolean | null>;
  dataSource: ChatThreadDataSource;
}): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const thread = await get(threadData$);
    signal.throwIfAborted();
    if (!thread) {
      set(loadedHistoryHasMore$, false);
      return;
    }

    const beforeId = await get(earliestChatMessageId$);
    signal.throwIfAborted();
    if (!beforeId) {
      set(loadedHistoryHasMore$, false);
      return;
    }

    const result = await set(
      dataSource.listMessagesBefore$,
      { threadId, beforeId },
      signal,
    );
    signal.throwIfAborted();

    set(historyMessages$, (prev) => {
      if (result.messages.length === 0) {
        return prev;
      }
      return [...result.messages, ...prev];
    });
    set(loadedHistoryHasMore$, result.hasMore);
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
  const internalSkeletonVisible$ = state(false);
  const skeletonVisible$ = computed((get) => {
    return get(internalSkeletonVisible$);
  });
  const showSkeleton$ = command(({ set }) => {
    set(internalSkeletonVisible$, true);
  });
  const hideSkeleton$ = command(({ set }) => {
    set(internalSkeletonVisible$, false);
  });
  return { skeletonVisible$, showSkeleton$, hideSkeleton$ };
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
  dataSource: ChatThreadDataSource;
}

interface MarkThreadReadDeps {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  latestChatMessageId$: Computed<Promise<string | undefined>>;
  locallyMarkedReadMessageId$: State<string | undefined>;
  dataSource: ChatThreadDataSource;
}

function createMarkThreadReadIfNeeded({
  threadId,
  threadData$,
  latestChatMessageId$,
  locallyMarkedReadMessageId$,
  dataSource,
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

    const newLastReadId = await set(
      dataSource.markRead$,
      { threadId, latestMessageId },
      sig,
    );
    sig.throwIfAborted();
    if (newLastReadId !== null) {
      set(locallyMarkedReadMessageId$, newLastReadId);
    }
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
  dataSource,
}: RunTrackingDeps) {
  const locallyMarkedReadMessageId$ = state<string | undefined>(undefined);

  const allFinished$ = computed(async (get) => {
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
    dataSource,
  });

  const subscribeChatThread$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      L.debug("subscribeChatThread$ start", { threadId });

      // Catch up any messages that arrived since the initial page was loaded.
      // On IDB cache hit this fetches messages that arrived after the cache
      // was written; on cache miss fetchNextPage$ hits reachedEnd (no-op).
      await set(fetchNextPage$, signal);

      // Track pending-message presence across reloads so we can re-scroll once
      // the server consumes a queued message: `onRunChanged$` reloads the
      // thread, the composer's queued card unmounts, and the message-list area
      // grows. Re-running autoScroll on the next frame keeps the viewport
      // pinned to the bottom across that layout shift. Gated on the feature
      // switch so the run-update realtime callback stays byte-identical for
      // users without the queue feature — no extra threadData$ read, no
      // extra animationFrame.
      const queueEnabled =
        get(featureSwitch$)[FeatureSwitchKey.QueueMessage] ?? false;
      const initialThread = queueEnabled ? await get(threadData$) : null;
      signal.throwIfAborted();
      let previouslyHadPending = Boolean(initialThread?.pendingMessage);

      const onMessageCreated$ = command(async ({ set }, sig: AbortSignal) => {
        await set(fetchNextPage$, sig);
        await set(markThreadReadIfNeeded$, sig);
        animationFrame(
          () => {
            set(autoScroll$);
          },
          { signal },
        );
        return false;
      });

      const onRunChanged$ = command(async ({ get, set }, sig: AbortSignal) => {
        set(reloadThread$);
        if (!queueEnabled) {
          return false;
        }
        const refreshed = await get(threadData$);
        sig.throwIfAborted();
        const hasPending = Boolean(refreshed?.pendingMessage);
        if (previouslyHadPending && !hasPending) {
          animationFrame(
            () => {
              set(autoScroll$);
            },
            { signal },
          );
        }
        previouslyHadPending = hasPending;
        return false;
      });

      await Promise.all([
        set(markThreadReadIfNeeded$, signal),
        set(
          dataSource.subscribeRealtime$,
          { threadId, handlers: { onMessageCreated$, onRunChanged$ } },
          signal,
        ),
      ]);
      signal.throwIfAborted();
    },
  );

  const cancelRun$ = command(async ({ get, set }, signal: AbortSignal) => {
    const thread = await get(threadData$);
    signal.throwIfAborted();
    if (!thread) {
      return;
    }
    await set(
      dataSource.cancelRuns$,
      { threadId, activeRunIds: thread.activeRunIds },
      signal,
    );
    signal.throwIfAborted();
  });

  return { allFinished$, subscribeChatThread$, cancelRun$ };
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
  return command(
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
      let effectiveSelectedModel = modelSelection?.selectedModel;
      if (!effectiveSelectedModel) {
        const agent = await get(agentById(agentId));
        signal.throwIfAborted();
        const composerProviders = await get(composerModelProviders$);
        signal.throwIfAborted();
        effectiveSelectedModel =
          resolveEffectiveAgentDefaultSelection({
            agent,
            providers: composerProviders.providers,
            tiers: composerProviders.tiers,
          })?.selectedModel ?? undefined;
      }

      const result = await set(
        prepareUserMessageFromDraft$,
        draft,
        prompt,
        {
          excludeVisualAttachments: shouldExcludeVisualAttachmentsForModel(
            effectiveSelectedModel,
          ),
        },
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
}

interface QueueMessageDeps {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  modelSelection$: Computed<Promise<ModelProviderSelection | null>>;
  draft: DraftSignals;
  cancelDraftSync$: Command<void, []>;
  flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
  reloadThread$: Command<void, []>;
  scrollToBottom$: Command<void, []>;
  dataSource: ChatThreadDataSource;
  setOptimisticPending$: Command<void, [PendingMessage | null]>;
}

function createQueueMessage(deps: QueueMessageDeps) {
  const {
    threadId,
    threadData$,
    modelSelection$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    reloadThread$,
    scrollToBottom$,
    dataSource,
    setOptimisticPending$,
  } = deps;
  return command(async ({ get, set }, prompt: string, signal: AbortSignal) => {
    L.debug("queueMessage$ start", { threadId, promptLen: prompt.length });
    const thread = await get(threadData$);
    signal.throwIfAborted();
    if (!thread || thread.activeRunIds.length === 0) {
      L.debug("queueMessage$ no active run, abort", { threadId });
      return;
    }

    const modelSelection = await get(modelSelection$);
    signal.throwIfAborted();
    const result = await set(
      prepareUserMessageFromDraft$,
      draft,
      prompt,
      {
        excludeVisualAttachments: shouldExcludeVisualAttachmentsForModel(
          modelSelection?.selectedModel,
        ),
      },
      signal,
    );
    if (!result) {
      L.debug("queueMessage$ prepare returned null, abort", { threadId });
      return;
    }
    signal.throwIfAborted();

    const content = result.hasTextContent ? result.prompt : undefined;
    const attachments = result.attachments;

    set(cancelDraftSync$);
    set(draft.clear$);

    // Pre-generate the client message id so the eventual auto-sent
    // chat_messages row uses it; the optimistic queued bubble is mounted
    // with this id so the merge-by-id reconciliation drops the dupe when
    // the real row arrives via Ably.
    const existingPending = thread.pendingMessage;
    const clientMessageId =
      existingPending?.clientMessageId ?? crypto.randomUUID();

    // Render the queued bubble synchronously, before any network round-trip.
    // `pendingMessage$` falls back to this slot until the server-confirmed
    // pending row lands in `threadData$`, at which point the finally block
    // below drops the optimistic copy.
    const nowIso = new Date().toISOString();
    set(setOptimisticPending$, {
      content: content ?? null,
      attachments:
        attachments && attachments.length > 0 ? [...attachments] : null,
      createdAt: existingPending?.createdAt ?? nowIso,
      updatedAt: nowIso,
      clientMessageId,
    });
    animationFrame(
      () => {
        set(scrollToBottom$);
      },
      { signal },
    );

    await Promise.all([
      set(flushDraftClear$, signal),
      set(
        dataSource.appendPendingMessage$,
        {
          threadId,
          content,
          attachments,
          clientMessageId,
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();

    set(reloadThread$);
    set(reloadChatThreads$);
    // Block until the refetched threadData$ resolves so the optimistic slot
    // is only cleared after the server-confirmed pending row is in place;
    // otherwise the queued bubble would flash off and back on.
    const refreshed = await get(threadData$);
    signal.throwIfAborted();
    // Only retire the optimistic bubble when the server-confirmed pending
    // row carries the same clientMessageId — proof that the backend actually
    // accepted this queue. In the new-thread optimistic window the local
    // data source is a no-op, so `refreshed.pendingMessage` stays null and
    // we leave the bubble in place; the local signals instance is torn down
    // when the page swaps to the real thread, taking the bubble with it.
    if (refreshed?.pendingMessage?.clientMessageId === clientMessageId) {
      set(setOptimisticPending$, null);
    }
    L.debug("queueMessage$ done", { threadId });
  });
}

interface RecallMessageDeps {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  draft: DraftSignals;
  cancelDraftSync$: Command<void, []>;
  reloadThread$: Command<void, []>;
  markPendingRecalled$: Command<void, [string]>;
  dataSource: ChatThreadDataSource;
}

function createRecallPendingMessage(deps: RecallMessageDeps) {
  const {
    threadId,
    threadData$,
    draft,
    cancelDraftSync$,
    reloadThread$,
    markPendingRecalled$,
    dataSource,
  } = deps;
  return command(async ({ get, set }, signal: AbortSignal) => {
    L.debug("recallPendingMessage$ start", { threadId });
    const thread = await get(threadData$);
    signal.throwIfAborted();
    const pending = thread?.pendingMessage;
    if (!pending) {
      return;
    }
    // Optimistic local state — the queued card disappears and the draft
    // refills synchronously, before the server round-trip. The mask hides
    // the cached pendingMessage by updatedAt until threadData$ is refetched
    // post-server-confirm, at which point the row is naturally gone.
    set(cancelDraftSync$);
    const restoredAttachments = (pending.attachments ?? []).map(
      createRestoredAttachment,
    );
    set(draft.seed$, pending.content ?? "", restoredAttachments);
    set(markPendingRecalled$, pending.updatedAt);

    // Server clear. Callers detach the returned promise via useSet so the
    // UI doesn't block on the round-trip — UX is already optimistic above.
    await set(dataSource.recallPendingMessage$, { threadId }, signal);
    signal.throwIfAborted();
    set(reloadThread$);
    set(reloadChatThreads$);
    L.debug("recallPendingMessage$ done", { threadId });
  });
}

interface MessageCommandsDeps
  extends
    SendMessageDeps,
    Omit<QueueMessageDeps, "setOptimisticPending$">,
    Omit<RecallMessageDeps, "markPendingRecalled$"> {}

function createMessageCommands(
  deps: MessageCommandsDeps & {
    groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>;
  },
) {
  const {
    pendingMessage$,
    pendingMessageIsOptimistic$,
    markPendingRecalled$,
    setOptimisticPending$,
  } = createPendingMessageView(deps.threadData$, deps.groupedChatMessages$);
  return {
    sendMessage$: createSendMessage(deps),
    queueMessage$: createQueueMessage({ ...deps, setOptimisticPending$ }),
    recallPendingMessage$: createRecallPendingMessage({
      ...deps,
      markPendingRecalled$,
    }),
    pendingMessage$,
    pendingMessageIsOptimistic$,
  };
}

// ---------------------------------------------------------------------------
// Sub-factory: pending-message view (with optimistic recall mask + dedup)
// ---------------------------------------------------------------------------

function createPendingMessageView(
  threadData$: Computed<Promise<ChatThread | null>>,
  groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>,
) {
  // Tracks the `updatedAt` of the pending message the user just recalled.
  // While the cached `threadData$` still echoes that same pending row back
  // (the fire-and-forget server clear hasn't landed yet), `pendingMessage$`
  // returns null so the queued card disappears synchronously on click.
  const internalRecalledUpdatedAt$ = state<string | null>(null);

  // Client-only optimistic queued bubble. Set synchronously by `queueMessage$`
  // before its POST flies, cleared in finally once the server-side pending row
  // round-trips into `threadData$`. Lives on the thread signal so each thread
  // has its own optimistic slot — switching threads does not leak state.
  const internalOptimisticPending$ = state<PendingMessage | null>(null);

  const setOptimisticPending$ = command(
    ({ set }, value: PendingMessage | null) => {
      set(internalOptimisticPending$, value);
    },
  );

  // Shared compute: pick the active pending row (server-confirmed wins over
  // optimistic) and remember which source it came from so the view layer can
  // tell apart "in flight" from "confirmed".
  const pendingMessageWithSource$ = computed(
    async (
      get,
    ): Promise<{ pending: PendingMessage; isOptimistic: boolean } | null> => {
      const thread = await get(threadData$);
      const serverPending = thread?.pendingMessage ?? null;
      const recalledUpdatedAt = get(internalRecalledUpdatedAt$);
      const serverPendingActive =
        serverPending && recalledUpdatedAt !== serverPending.updatedAt
          ? serverPending
          : null;
      const optimistic = get(internalOptimisticPending$);
      const source = serverPendingActive ?? optimistic;
      if (!source) {
        return null;
      }
      // Dedup by client message id: when auto-send claims the queued
      // message, it inserts a chat_messages row reusing the queued
      // bubble's pre-generated id. Once the realtime fetcher surfaces
      // that row, the queued bubble must vacate so we don't paint the
      // same user message twice.
      if (source.clientMessageId) {
        const groups = await get(groupedChatMessages$);
        const matched = groups.some((group) => {
          return group.messages.some((message) => {
            return message.id === source.clientMessageId;
          });
        });
        if (matched) {
          return null;
        }
      }
      return {
        pending: source,
        isOptimistic: serverPendingActive === null,
      };
    },
  );

  const pendingMessage$ = computed(
    async (get): Promise<PendingMessage | null> => {
      const view = await get(pendingMessageWithSource$);
      return view?.pending ?? null;
    },
  );

  const pendingMessageIsOptimistic$ = computed(async (get) => {
    const view = await get(pendingMessageWithSource$);
    return view?.isOptimistic ?? false;
  });

  const markPendingRecalled$ = command(({ set }, updatedAt: string) => {
    set(internalRecalledUpdatedAt$, updatedAt);
  });

  return {
    pendingMessage$,
    pendingMessageIsOptimistic$,
    markPendingRecalled$,
    setOptimisticPending$,
  };
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
  dataSource: ChatThreadDataSource = createRemoteChatThreadDataSource(threadId),
): ChatThreadSignals {
  const { threadData$, reloadThread$ } = createThreadData(dataSource);
  const { modelSelection$, setModelSelection$ } =
    createModelSelection(threadData$);
  const { recordScrollHeightForPrepend$, ...scrollSignals } =
    createScrollSignals(threadId);
  const { skeletonVisible$, showSkeleton$, hideSkeleton$ } =
    createSkeletonSignals();
  const { composerFileInput$, setComposerFileInput$ } =
    createComposerFileInput();
  const { agentId$, agentDisplayName$, agentModelDefault$, agentPinned$ } =
    createAgentInfoSignals(threadId, threadData$);
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
  } = createPagedMessages(threadId, threadData$, dataSource);

  const loadHistory$ = createLoadHistoryWithPrependScroll(
    recordScrollHeightForPrepend$,
    loadPagedHistory$,
  );

  const { scheduleDraftSync$, cancelDraftSync$, flushDraftClear$ } =
    createDraftSync(threadId, draft, dataSource);
  const { allFinished$, subscribeChatThread$, cancelRun$ } = createRunTracking({
    threadId,
    reloadThread$,
    threadData$,
    latestChatMessageId$,
    fetchNextPage$,
    autoScroll$: scrollSignals.autoScroll$,
    dataSource,
  });

  const messageCommands = createMessageCommands({
    threadId,
    threadData$,
    modelSelection$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    insertOptimisticMessage$,
    scrollToBottom$: scrollSignals.scrollToBottom$,
    reloadThread$,
    dataSource,
    groupedChatMessages$,
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

  return {
    threadId,
    threadData$,
    modelSelection$,
    setModelSelection$,
    ...messageCommands,
    cancelRun$,
    ...scrollSignals,
    skeletonVisible$,
    showSkeleton$,
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
    scheduleDraftSync$,
    earliestChatMessageId$,
    latestChatMessageId$,
    groupedChatMessages$,
    hasOlderHistory$,
    latestRunStatus$,
    allFinished$,
    fetchNextPage$,
    loadHistory$,
    subscribeChatThread$,
    insertOptimisticMessage$,
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
