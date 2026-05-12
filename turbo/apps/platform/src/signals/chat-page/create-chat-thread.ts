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
  isVisualAttachment,
  prepareUserMessageFromDraft$,
  shouldExcludeVisualAttachmentsForModel,
} from "./resolve-draft-attachments.ts";
import {
  appendOptimisticChatMessage$,
  createOptimisticChatMessagesForThread,
  reconcileOptimisticChatMessages$,
  type OptimisticChatMessageEntry,
} from "./optimistic-chat-messages.ts";
import { reloadChatThreads$, type ChatThread } from "../agent-chat.ts";
import {
  chatMessagesContract,
  chatThreadArtifactsContract,
  type ChatThreadArtifactRun,
  type ModelSelectionRequest,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { agentById } from "../agent.ts";
import { goalEnabled$ } from "../external/feature-switch.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import { pinnedAgentIds$ } from "../zero-page/zero-pinned-agents.ts";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  resolveModelFirstUserDefaultSelection,
} from "../zero-page/model-default-selection.ts";
import {
  writeChatMessageToClipboard,
  type ChatClipboardPayload,
} from "../zero-page/clipboard.ts";
import type {
  EnrichedChatMessage,
  GroupedChatMessageGroup,
} from "./chat-message.ts";
import { logger } from "../log.ts";
import type {
  ChatThreadDataSource,
  InitialPage,
} from "./chat-thread-data-source.ts";
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

function isRecallControlMessage(msg: PagedChatMessage): boolean {
  return (
    msg.role === "user" &&
    msg.runId === undefined &&
    msg.revokesMessageId !== undefined
  );
}

function isInterruptControlMessage(msg: PagedChatMessage): boolean {
  return (
    msg.role === "user" &&
    msg.runId === undefined &&
    msg.interruptsRunId !== undefined
  );
}

function isCancelledAssistantMessage(msg: PagedChatMessage): boolean {
  return (
    msg.role === "assistant" &&
    msg.runId !== undefined &&
    msg.error?.trim().toLowerCase() === "run cancelled"
  );
}

function createInterruptedAssistantMessage(
  message: PagedChatMessage,
  runId: string,
): EnrichedChatMessage {
  const { blocks } = parseBodyRenderBlocks("Run cancelled");
  return {
    ...message,
    role: "assistant" as const,
    content: "Run cancelled",
    runId,
    interruptsRunId: runId,
    error: "Run cancelled",
    status: "cancelled",
    blocks: enrichBlocksWithTextPreviews(blocks),
    isQueued: false,
    isOptimisticRun: false,
  };
}

function isInterruptedAssistantCancellation(
  message: PagedChatMessage,
  interruptedRunIds: Set<string>,
): boolean {
  const runId = message.runId;
  return (
    runId !== undefined &&
    isCancelledAssistantMessage(message) &&
    interruptedRunIds.has(runId)
  );
}

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
    [string, ModelSelectionRequest | null, SendMessageOptions, AbortSignal]
  >;
  queueMessage$: Command<Promise<void>, [string, AbortSignal]>;
  recallMessage$: Command<Promise<void>, [EnrichedChatMessage, AbortSignal]>;
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
  defaultModelSelection$: Computed<Promise<ModelProviderSelection | null>>;
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
      if (thread?.selectedModel) {
        return {
          modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
          selectedModel: thread.selectedModel,
        };
      }
      // Unstarted model-first threads inherit the current user preference;
      // started threads carry selectedModel on the thread row.
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
  threadId: string,
  threadData$: Computed<Promise<ChatThread | null>>,
) {
  // agentId$ is read by avatar and pinned UI on first paint.
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

  const defaultModelSelection$ = computed(
    async (get): Promise<ModelProviderSelection | null> => {
      const policies = await get(orgModelPolicies$);
      const userPreference = await get(userModelPreference$);
      return resolveModelFirstUserDefaultSelection({
        userPreference,
        policies,
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

  return { agentId$, agentDisplayName$, defaultModelSelection$, agentPinned$ };
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
      await delay(DRAFT_SYNC_DEBOUNCE_MS, { signal });
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

function groupMessagesForDisplay(
  messages: EnrichedChatMessage[],
): GroupedChatMessageGroup[] {
  const activeMessages: EnrichedChatMessage[] = [];
  const queuedMessages: EnrichedChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "user" && msg.isQueued) {
      queuedMessages.push(msg);
      continue;
    }
    activeMessages.push(msg);
  }
  return [
    ...mergeIntoGroups([], activeMessages),
    ...mergeIntoGroups([], queuedMessages),
  ];
}

type ServerMessages$ = State<PagedChatMessage[]>;

function createAppendServerMessages(
  threadId: string,
  serverMessages$: ServerMessages$,
) {
  return command(({ set }, msgs: PagedChatMessage[]) => {
    if (msgs.length === 0) {
      return;
    }
    set(serverMessages$, (prev) => {
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
    set(reconcileOptimisticChatMessages$, { threadId, messages: msgs });
  });
}

function createInitialPage(dataSource: ChatThreadDataSource) {
  return dataSource.initialPage$;
}

function createBackfillHistoryBoundaryCommand({
  threadId,
  initialPage$,
  loadedHistoryHasMore$,
  dataSource,
}: {
  threadId: string;
  initialPage$: Computed<Promise<InitialPage>>;
  loadedHistoryHasMore$: State<boolean | null>;
  dataSource: ChatThreadDataSource;
}) {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const initial = await get(initialPage$);
    signal.throwIfAborted();
    if (!initial.needsHistoryBackfill) {
      return;
    }

    const beforeId = initial.messages[0]?.id;
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
    set(loadedHistoryHasMore$, result.messages.length > 0 || result.hasMore);
  });
}

interface ChatMessageProjectionEntry {
  message: PagedChatMessage;
  optimisticUserMessageAssociation?: OptimisticChatMessageEntry["optimisticUserMessageAssociation"];
}

function createRawMessagesComputed({
  initialPage$,
  historyMessages$,
  serverMessages$,
  optimisticMessages$,
}: {
  initialPage$: Computed<
    Promise<{ messages: PagedChatMessage[]; hasHistoryBefore: boolean }>
  >;
  historyMessages$: State<PagedChatMessage[]>;
  serverMessages$: State<PagedChatMessage[]>;
  optimisticMessages$: Computed<OptimisticChatMessageEntry[]>;
}): Computed<Promise<ChatMessageProjectionEntry[]>> {
  return computed(async (get): Promise<ChatMessageProjectionEntry[]> => {
    const initial = await get(initialPage$);
    const history = get(historyMessages$);
    const server = [...history, ...initial.messages, ...get(serverMessages$)];
    const serverIds = new Set(
      server.map((message) => {
        return message.id;
      }),
    );
    const optimistic = get(optimisticMessages$).filter((entry) => {
      return !serverIds.has(entry.message.id);
    });
    const raw: ChatMessageProjectionEntry[] = [
      ...server.map((message) => {
        return { message };
      }),
      ...optimistic,
    ];
    return raw;
  });
}

function createInterruptedRunIdsComputed(
  rawMessages$: Computed<Promise<ChatMessageProjectionEntry[]>>,
): Computed<Promise<Set<string>>> {
  return computed(async (get): Promise<Set<string>> => {
    const raw = await get(rawMessages$);
    return new Set(
      raw.flatMap((entry) => {
        const { message } = entry;
        return isInterruptControlMessage(message) && message.interruptsRunId
          ? [message.interruptsRunId]
          : [];
      }),
    );
  });
}

function createAllMessagesComputed(
  rawMessages$: Computed<Promise<ChatMessageProjectionEntry[]>>,
): Computed<Promise<EnrichedChatMessage[]>> {
  return computed(async (get): Promise<EnrichedChatMessage[]> => {
    const raw = await get(rawMessages$);
    const interruptedRunIds = new Set(
      raw.flatMap((entry) => {
        const { message } = entry;
        return isInterruptControlMessage(message) && message.interruptsRunId
          ? [message.interruptsRunId]
          : [];
      }),
    );
    const recalledIds = new Set(
      raw.flatMap((entry) => {
        const { message } = entry;
        return isRecallControlMessage(message) && message.revokesMessageId
          ? [message.revokesMessageId]
          : [];
      }),
    );
    const replacedIds = new Set(
      raw.flatMap((entry) => {
        const { message } = entry;
        return !isRecallControlMessage(message) && message.revokesMessageId
          ? [message.revokesMessageId]
          : [];
      }),
    );
    return raw
      .filter((entry) => {
        return (
          !isRecallControlMessage(entry.message) &&
          !isInterruptedAssistantCancellation(
            entry.message,
            interruptedRunIds,
          ) &&
          !recalledIds.has(entry.message.id) &&
          !replacedIds.has(entry.message.id)
        );
      })
      .map((entry) => {
        const { message } = entry;
        if (isInterruptControlMessage(message) && message.interruptsRunId) {
          return createInterruptedAssistantMessage(
            message,
            message.interruptsRunId,
          );
        }
        const { blocks } = parseBodyRenderBlocks(message.content ?? "");
        const isUnassociatedUser =
          message.role === "user" && message.runId === undefined;
        const optimisticAssociation = entry.optimisticUserMessageAssociation;
        const isOptimisticRun =
          isUnassociatedUser && optimisticAssociation === "run";
        const isQueued = isUnassociatedUser && optimisticAssociation !== "run";
        if (message.role !== "assistant") {
          return {
            ...message,
            role: "user" as const,
            blocks: enrichBlocksWithTextPreviews(blocks),
            isQueued,
            isOptimisticRun,
          };
        }
        return {
          ...message,
          role: "assistant" as const,
          blocks: enrichBlocksWithTextPreviews(blocks),
          isQueued,
          isOptimisticRun: false,
        };
      });
  });
}

function createFetchNextPageCommand({
  threadId,
  initialPage$,
  nextCursorId$,
  appendServerMessages$,
  dataSource,
}: {
  threadId: string;
  initialPage$: Computed<Promise<InitialPage>>;
  nextCursorId$: State<string | undefined>;
  appendServerMessages$: Command<void, [PagedChatMessage[]]>;
  dataSource: ChatThreadDataSource;
}): Command<Promise<boolean>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal) => {
    let sinceId: string | undefined = get(nextCursorId$);
    if (!sinceId) {
      const initial = await get(initialPage$);
      signal.throwIfAborted();
      set(reconcileOptimisticChatMessages$, {
        threadId,
        messages: initial.messages,
      });
      sinceId = initial.messages[initial.messages.length - 1]?.id;
      L.debug("fetchNextPage$ initialPage seeded sinceId", {
        threadId,
        sinceId: sinceId ?? null,
        initialCount: initial.messages.length,
      });
      if (sinceId) {
        set(nextCursorId$, sinceId);
      }
    }
    signal.throwIfAborted();
    // No sinceId is *not* the same as "nothing to fetch": the server side
    // accepts an absent cursor and returns the latest page in that case.
    // Brand-new threads hit this path when the swap-time `initialPage$`
    // fetch raced ahead of the server-side persist and got cached as
    // empty — without a full fetch here, every Ably-triggered call would
    // exit early and the rendered list would stay stuck on the thinking
    // indicator. Drain all pending pages so a single trigger fully catches
    // the client up; without this loop a burst larger than one page leaves
    // the client permanently behind if the thread goes quiet afterwards.
    const MAX_PAGES = 10;
    for (let i = 0; i < MAX_PAGES; i++) {
      const result: { messages: PagedChatMessage[]; reachedEnd: boolean } =
        await set(dataSource.listMessagesAfter$, { threadId, sinceId }, signal);
      signal.throwIfAborted();
      L.debug("fetchNextPage$ listMessagesAfter result", {
        threadId,
        sinceId: sinceId ?? null,
        gotCount: result.messages.length,
        reachedEnd: result.reachedEnd,
        page: i,
      });
      if (result.messages.length > 0) {
        set(appendServerMessages$, result.messages);
        sinceId = result.messages[result.messages.length - 1].id;
        set(nextCursorId$, sinceId);
      }
      if (result.reachedEnd) {
        return true;
      }
    }
    return false;
  });
}

function createPagedMessages(
  threadId: string,
  threadData$: Computed<Promise<ChatThread | null>>,
  dataSource: ChatThreadDataSource,
) {
  const loadedHistoryHasMore$ = state<boolean | null>(null);
  const historyMessages$ = state<PagedChatMessage[]>([]);
  const initialPage$ = createInitialPage(dataSource);

  const serverMessages$ = state<PagedChatMessage[]>([]);
  const appendServerMessages$ = createAppendServerMessages(
    threadId,
    serverMessages$,
  );
  const optimisticMessages$ = createOptimisticChatMessagesForThread(threadId);

  // Tracks the last known server-validated message ID so optimistic
  // (client-generated) IDs never leak into sinceId calls.
  // Lazy-init from initialPage$ on first fetchNextPage$ call, then
  // advanced after each successful fetch to the last returned message.
  const nextCursorId$ = state<string | undefined>(undefined);

  const rawMessages$ = createRawMessagesComputed({
    initialPage$,
    historyMessages$,
    serverMessages$,
    optimisticMessages$,
  });
  const interruptedRunIds$ = createInterruptedRunIdsComputed(rawMessages$);
  const allMessages$ = createAllMessagesComputed(rawMessages$);

  const groupedChatMessages$ = computed(
    async (get): Promise<GroupedChatMessageGroup[]> => {
      return groupMessagesForDisplay(await get(allMessages$));
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

  const backfillHistoryBoundary$ = createBackfillHistoryBoundaryCommand({
    threadId,
    initialPage$,
    loadedHistoryHasMore$,
    dataSource,
  });

  const fetchNextPage$ = createFetchNextPageCommand({
    threadId,
    initialPage$,
    nextCursorId$,
    appendServerMessages$,
    dataSource,
  });

  const refreshLatestMessages$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const result = await set(
        dataSource.listMessagesAfter$,
        { threadId, sinceId: undefined },
        signal,
      );
      signal.throwIfAborted();
      set(appendServerMessages$, result.messages);
    },
  );

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
    interruptedRunIds$,
    fetchNextPage$,
    backfillHistoryBoundary$,
    refreshLatestMessages$,
    loadHistory$,
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
    set(reconcileOptimisticChatMessages$, {
      threadId,
      messages: result.messages,
    });

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
  interruptedRunIds$: Computed<Promise<Set<string>>>;
  latestChatMessageId$: Computed<Promise<string | undefined>>;
  fetchNextPage$: Command<Promise<boolean>, [AbortSignal]>;
  backfillHistoryBoundary$: Command<Promise<void>, [AbortSignal]>;
  refreshLatestMessages$: Command<Promise<void>, [AbortSignal]>;
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
  interruptedRunIds$,
  latestChatMessageId$,
  fetchNextPage$,
  backfillHistoryBoundary$,
  refreshLatestMessages$,
  autoScroll$,
  dataSource,
}: RunTrackingDeps) {
  const locallyMarkedReadMessageId$ = state<string | undefined>(undefined);

  const allFinished$ = computed(async (get) => {
    const thread = await get(threadData$);
    if (!thread) {
      return false;
    }
    const interruptedRunIds = await get(interruptedRunIds$);
    return thread.activeRunIds.every((runId) => {
      return interruptedRunIds.has(runId);
    });
  });

  const markThreadReadIfNeeded$ = createMarkThreadReadIfNeeded({
    threadId,
    threadData$,
    latestChatMessageId$,
    locallyMarkedReadMessageId$,
    dataSource,
  });

  const subscribeChatThread$ = command(async ({ set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ start", { threadId });

    // Catch up any messages that arrived since the initial page was loaded.
    // On IDB cache hit this fetches messages that arrived after the cache
    // was written; on cache miss `fetchNextPage$` issues a no-cursor fetch
    // (since the contract treats `sinceId` as optional) and ingests the
    // server's latest page. This must run before the subscribe loop below
    // because that loop never resolves — `setAblyLoop$` blocks on the
    // realtime channel for the lifetime of the thread.
    L.debug("subscribeChatThread$ pre-subscribe fetchNextPage$ start", {
      threadId,
    });
    await set(fetchNextPage$, signal);
    L.debug("subscribeChatThread$ pre-subscribe fetchNextPage$ done", {
      threadId,
    });

    const onMessageCreated$ = command(async ({ set }, sig: AbortSignal) => {
      L.debug("onMessageCreated$ fired", { threadId });
      await set(fetchNextPage$, sig);
      L.debug("onMessageCreated$ fetchNextPage$ done", { threadId });
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
      L.debug("onRunChanged$ fired", { threadId });
      set(reloadThread$);
      await set(refreshLatestMessages$, sig);
      sig.throwIfAborted();
      await get(threadData$);
      animationFrame(
        () => {
          set(autoScroll$);
        },
        { signal },
      );
      return false;
    });

    L.debug("subscribeChatThread$ subscribeRealtime$ start", { threadId });
    await Promise.all([
      set(backfillHistoryBoundary$, signal),
      set(markThreadReadIfNeeded$, signal),
      set(
        dataSource.subscribeRealtime$,
        { threadId, handlers: { onMessageCreated$, onRunChanged$ } },
        signal,
      ),
    ]);
    signal.throwIfAborted();
  });

  const cancelRun$ = command(async ({ get, set }, signal: AbortSignal) => {
    const thread = await get(threadData$);
    signal.throwIfAborted();
    if (!thread) {
      return;
    }
    await set(
      dataSource.cancelRuns$,
      {
        threadId,
        agentId: thread.agentId,
        interrupts: thread.activeRunIds.map((runId) => {
          return { runId, clientMessageId: crypto.randomUUID() };
        }),
      },
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
  scrollToBottom$: Command<void, []>;
}

/**
 * Per-send options. `goal: true` flags this send as starting a Codex-style
 * goal chain — the API stamps the user row with `goal_remaining_turns` and
 * the run-completion callback auto-continues until the agent emits
 * `[GOAL_DONE]`, the run fails, the user interrupts, or the budget runs out.
 * Gated by the `Goal` feature switch via `goalEnabled$`.
 */
export interface SendMessageOptions {
  goal?: boolean;
}

function createSendMessage(deps: SendMessageDeps) {
  const {
    threadId,
    threadData$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    scrollToBottom$,
  } = deps;
  return command(
    async (
      { get, set },
      prompt: string,
      modelSelection: ModelSelectionRequest | null,
      options: SendMessageOptions,
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
      // Goal mode is opt-in per send (driven by the composer's "Send as goal"
      // dropdown item). The Goal feature switch gates that UI affordance, so
      // the explicit `options.goal` flag is the source of truth here.
      const isGoal = options.goal === true && get(goalEnabled$);
      const hasVisualAttachments = get(draft.attachments$).some(
        (attachment) => {
          return isVisualAttachment(attachment);
        },
      );
      let effectiveSelectedModel = modelSelection?.selectedModel;
      if (!effectiveSelectedModel && hasVisualAttachments) {
        const policies = await get(orgModelPolicies$);
        signal.throwIfAborted();
        const userPreference = await get(userModelPreference$);
        signal.throwIfAborted();
        effectiveSelectedModel =
          resolveModelFirstUserDefaultSelection({
            userPreference,
            policies,
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
      set(appendOptimisticChatMessage$, {
        threadId,
        optimisticUserMessageAssociation: "run",
        message: {
          id: clientMessageId,
          role: "user",
          content: result.prompt,
          attachFiles: result.attachments,
          createdAt: new Date().toISOString(),
        },
      });
      animationFrame(
        () => {
          set(scrollToBottom$);
        },
        { signal },
      );

      // Model-first lets the user swap models mid-thread (the picker stays
      // editable). When the new selection differs from the thread's pinned
      // model, signal the server to start a fresh CLI session — resuming the
      // existing sessionId across providers/models triggers
      // PROVIDER_INCOMPATIBLE (or "Invalid signature in thinking block") on
      // the runner side. The server then injects prior chat messages into
      // the system prompt so the agent still has conversation context.
      const threadPinSelectedModel = thread?.selectedModel ?? null;
      const forceNewSession =
        threadPinSelectedModel !== null &&
        effectiveSelectedModel !== undefined &&
        threadPinSelectedModel !== effectiveSelectedModel;

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
              ...(isGoal ? { goal: true } : {}),
              ...(forceNewSession ? { forceNewSession: true } : {}),
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
  scrollToBottom$: Command<void, []>;
  dataSource: ChatThreadDataSource;
}

function createQueueMessage(deps: QueueMessageDeps) {
  const {
    threadId,
    threadData$,
    modelSelection$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    scrollToBottom$,
    dataSource,
  } = deps;

  return command(async ({ get, set }, prompt: string, signal: AbortSignal) => {
    L.debug("queueMessage$ start", { threadId, promptLen: prompt.length });
    const thread = await get(threadData$);
    signal.throwIfAborted();
    if (!thread) {
      L.debug("queueMessage$ no thread data, abort", { threadId });
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

    set(cancelDraftSync$);
    set(draft.clear$);

    const clientMessageId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    set(appendOptimisticChatMessage$, {
      threadId,
      optimisticUserMessageAssociation: "queue",
      message: {
        id: clientMessageId,
        role: "user",
        content: result.prompt,
        attachFiles: result.attachments,
        createdAt: nowIso,
      },
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
        dataSource.appendQueuedMessage$,
        {
          threadId,
          agentId: thread.agentId,
          content: result.prompt,
          attachments: result.attachments ?? null,
          clientMessageId,
          hasTextContent: result.hasTextContent,
          modelSelection,
        },
        signal,
      ),
    ]);
    signal.throwIfAborted();

    set(reloadChatThreads$);
    L.debug("queueMessage$ done", { threadId });
  });
}

interface RecallMessageDeps {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  draft: DraftSignals;
  dataSource: ChatThreadDataSource;
}

function createRecallMessage(deps: RecallMessageDeps) {
  const { threadId, threadData$, draft, dataSource } = deps;

  return command(
    async ({ get, set }, message: EnrichedChatMessage, signal: AbortSignal) => {
      if (
        message.role !== "user" ||
        message.runId !== undefined ||
        message.revokesMessageId !== undefined
      ) {
        return;
      }

      const thread = await get(threadData$);
      signal.throwIfAborted();
      if (!thread) {
        return;
      }

      const clientMessageId = crypto.randomUUID();
      set(appendOptimisticChatMessage$, {
        threadId,
        message: {
          id: clientMessageId,
          role: "user",
          content: null,
          revokesMessageId: message.id,
          createdAt: new Date().toISOString(),
        },
      });
      set(
        draft.seed$,
        message.content ?? "",
        (message.attachFiles ?? []).map(createRestoredAttachment),
      );

      await set(
        dataSource.recallMessage$,
        {
          threadId,
          agentId: thread.agentId,
          revokesMessageId: message.id,
          clientMessageId,
        },
        signal,
      );
      signal.throwIfAborted();
    },
  );
}

interface MessageCommandsDeps
  extends SendMessageDeps, QueueMessageDeps, RecallMessageDeps {}

function createMessageCommands(deps: MessageCommandsDeps) {
  return {
    sendMessage$: createSendMessage(deps),
    queueMessage$: createQueueMessage(deps),
    recallMessage$: createRecallMessage(deps),
  };
}

function createCancelRunWithQueuedRecall({
  threadId,
  threadData$,
  groupedChatMessages$,
  dataSource,
}: {
  threadId: string;
  threadData$: Computed<Promise<ChatThread | null>>;
  groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>;
  dataSource: ChatThreadDataSource;
}) {
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const thread = await get(threadData$);
    signal.throwIfAborted();
    if (!thread) {
      return;
    }

    const groups = await get(groupedChatMessages$);
    signal.throwIfAborted();
    const queuedMessages = groups.flatMap((group) => {
      return group.messages.filter((message) => {
        return (
          message.role === "user" &&
          message.isQueued &&
          message.runId === undefined &&
          message.revokesMessageId === undefined
        );
      });
    });

    const interruptRequests = thread.activeRunIds.map((runId) => {
      const clientMessageId = crypto.randomUUID();
      set(appendOptimisticChatMessage$, {
        threadId,
        message: {
          id: clientMessageId,
          role: "user",
          content: null,
          interruptsRunId: runId,
          createdAt: new Date().toISOString(),
        },
      });
      return { runId, clientMessageId };
    });

    const recallRequests = queuedMessages.map((message) => {
      const clientMessageId = crypto.randomUUID();
      set(appendOptimisticChatMessage$, {
        threadId,
        message: {
          id: clientMessageId,
          role: "user",
          content: null,
          revokesMessageId: message.id,
          createdAt: new Date().toISOString(),
        },
      });
      return {
        threadId,
        agentId: thread.agentId,
        revokesMessageId: message.id,
        clientMessageId,
      };
    });

    await Promise.all([
      set(
        dataSource.cancelRuns$,
        {
          threadId,
          agentId: thread.agentId,
          interrupts: interruptRequests,
        },
        signal,
      ),
      ...recallRequests.map((request) => {
        return set(dataSource.recallMessage$, request, signal);
      }),
    ]);
    signal.throwIfAborted();
    set(reloadChatThreads$);
  });
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
  const { agentId$, agentDisplayName$, defaultModelSelection$, agentPinned$ } =
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
    interruptedRunIds$,
    fetchNextPage$,
    backfillHistoryBoundary$,
    refreshLatestMessages$,
    loadHistory$: loadPagedHistory$,
  } = createPagedMessages(threadId, threadData$, dataSource);

  const loadHistory$ = createLoadHistoryWithPrependScroll(
    recordScrollHeightForPrepend$,
    loadPagedHistory$,
  );

  const { scheduleDraftSync$, cancelDraftSync$, flushDraftClear$ } =
    createDraftSync(threadId, draft, dataSource);
  const runTracking = createRunTracking({
    threadId,
    reloadThread$,
    threadData$,
    interruptedRunIds$,
    latestChatMessageId$,
    fetchNextPage$,
    backfillHistoryBoundary$,
    refreshLatestMessages$,
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
    scrollToBottom$: scrollSignals.scrollToBottom$,
    dataSource,
  });

  const cancelRun$ = createCancelRunWithQueuedRecall({
    threadId,
    threadData$,
    groupedChatMessages$,
    dataSource,
  });

  const { setInputRef$, focusInput$ } = createInputRef();
  const { blockColors$, rotatingPhrase$, donePhrase$, runPhraseLoop$ } =
    createPhraseLoop(groupedChatMessages$, runTracking.allFinished$);
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
    defaultModelSelection$,
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
    allFinished$: runTracking.allFinished$,
    fetchNextPage$,
    loadHistory$,
    subscribeChatThread$: runTracking.subscribeChatThread$,
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
