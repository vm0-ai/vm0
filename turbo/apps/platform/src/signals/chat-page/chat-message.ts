import { command, computed, state, type Computed } from "ccstate";
import type { AgentEvent, LogStatus } from "../zero-page/log-types.ts";
import { onRef, resetSignal } from "../utils.ts";
import { ablyNotify$ } from "../realtime.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { logger } from "../log.ts";
import {
  currentDraft$,
  type DraftSignals,
  type ZeroChatAttachment,
} from "../zero-page/chat-draft.ts";
import { createRunLoop, type PagedRunEvents } from "../zero-page/polling.ts";
import {
  markMessageLoading$,
  checkAutoRead$,
} from "../voice-io/voice-io-tts.ts";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import { navigateToChat$ } from "../zero-page/zero-nav.ts";
import {
  currentChatThreadId$,
  chatThreads$,
  currentChatThread$,
  reloadChatThreads$,
  reloadCurrentChatThread$,
  type ChatThread,
} from "../agent-chat.ts";
import {
  chatMessagesContract,
  chatThreadsContract,
  chatThreadByIdContract,
} from "@vm0/core";
import { accept } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";

export {
  chatThreads$,
  currentChatThread$,
  reloadChatThreads$,
} from "../agent-chat.ts";

export {
  zeroChatInput$,
  setZeroChatInput$,
  clearZeroChatInput$,
  zeroChatAttachments$,
  uploadZeroAttachment$,
  removeZeroAttachment$,
  zeroDragOver$,
  setZeroDragOver$,
  canSendZeroChat$,
  type ZeroChatAttachment,
} from "../zero-page/chat-draft.ts";

const L = logger("ChatMessage");

async function createChatThread(
  createClient: ZeroClientFactory,
  agentId: string,
  title?: string,
): Promise<{ id: string; title: string | null }> {
  const client = createClient(chatThreadsContract);
  const result = await accept(
    client.create({ body: { agentId, ...(title ? { title } : {}) } }),
    [201],
  );
  return { id: result.body.id, title: result.body.title };
}

interface ZeroChatMessageAttachment {
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

export interface UserChatMessage {
  id: string;
  role: "user";
  content: string;
  attachments?: ZeroChatMessageAttachment[];
  createdAt?: string;
}

export interface AssistantChatMessage {
  id: string;
  role: "assistant";
  result$: Computed<Promise<string>>;
  legacyRunId?: string;
  status?: LogStatus;
  error?: string;
  cancelled?: boolean;
  runLoop?: ReturnType<typeof createRunLoop>;
  summaries$?: Computed<Promise<string[]>>;
  /** All intermediate text outputs from the run's event stream (live). */
  texts$?: Computed<Promise<string[]>>;
  createdAt?: string;
}

export type ZeroChatMessage = UserChatMessage | AssistantChatMessage;

const internalLocalMessages$ = state<ZeroChatMessage[]>([]);

/**
 * Derive a deterministic placeholder ID from a user message ID by appending a
 * fixed suffix.  This avoids BigInt arithmetic and the edge-case overflow that
 * would occur when all hex digits are `f`.
 */
function placeholderIdFromUser(userMessageId: string): string {
  return `${userMessageId}-placeholder`;
}

/**
 * A computed signal whose inner promise never settles.  Used by the placeholder
 * assistant message so that any subscriber awaiting `result$`, `finished$`,
 * etc. stays pending until the placeholder is replaced by a real message.
 *
 * Because the promise never resolves, await chains on it become unreachable
 * and will be garbage-collected once all references to the placeholder are
 * dropped (i.e. when the real assistant message arrives and the derived
 * `zeroChatMessages$` no longer includes the placeholder).
 */
const neverResolve$ = computed((): Promise<never> => {
  return new Promise<never>(() => {});
});

/**
 * Create a lightweight placeholder assistant message that is derived (not
 * stored) inside `zeroChatMessages$`.  All async computed signals never
 * resolve and all commands are no-ops, so the placeholder is completely
 * inert — it exists only to give the UI something to render immediately.
 */
export function createPlaceholderAssistantMessage(
  userMessageId: string,
): AssistantChatMessage {
  const noopAsyncCommand$ = command(async (_store, _signal: AbortSignal) => {});
  return {
    id: placeholderIdFromUser(userMessageId),
    role: "assistant",
    result$: neverResolve$,
    createdAt: new Date().toISOString(),
    runLoop: {
      pagedEventsList$: neverResolve$,
      cancel$: noopAsyncCommand$,
      detail$: neverResolve$,
      queuePosition$: neverResolve$,
      finished$: neverResolve$,
      checkFinished$: command(async ({ get }, _signal: AbortSignal) => {
        await get(neverResolve$);
        return false;
      }),
    },
    summaries$: neverResolve$,
  };
}

export const zeroChatMessages$ = computed(async (get) => {
  const messages = await get(chatMessages$);
  const serverMessages = messages?.messages ?? [];
  const localMessages = get(internalLocalMessages$);

  // Deduplicate: if the server already has a message for a given runId,
  // drop the local copy (server is the canonical source after persistence).
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
      // Also skip the paired user message immediately before
      if (i > 0 && localMessages[i - 1].role === "user") {
        skipIndices.add(i - 1);
      }
    }
  }

  const filteredLocal = localMessages.filter((_, i) => {
    return !skipIndices.has(i);
  });
  const merged = [...serverMessages, ...filteredLocal];

  // If the last local message is a user message with no following assistant
  // message, derive a placeholder assistant message so the UI can show
  // immediate feedback (avatar, spinner, disabled input) before the server
  // responds with a runId.
  const last = filteredLocal[filteredLocal.length - 1];
  if (last?.role === "user") {
    merged.push(createPlaceholderAssistantMessage(last.id));
  }

  return merged;
});

export const allFinished$ = computed(async (get) => {
  const messages = await get(zeroChatMessages$);
  return (
    await Promise.all(
      messages.map(async (message) => {
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

interface EventContent {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface EventData {
  message?: { content?: EventContent[] };
}

function getEventContent(event: AgentEvent): EventContent[] {
  const data = event.eventData as EventData | null;
  return data?.message?.content ?? [];
}

function hasTextBlock(event: AgentEvent): boolean {
  return getEventContent(event).some((b) => {
    return b.type === "text" && b.text;
  });
}

function basename(filepath: string): string {
  return filepath.split("/").pop() ?? filepath;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function domainFromUrl(url: string): string {
  if (!URL.canParse(url)) {
    return truncate(url, 30);
  }
  return new URL(url).hostname.replace(/^www\./, "");
}

export const THINKING_MESSAGES = [
  "On it, grab a coffee",
  "Thinking hard...",
  "Cooking up something good...",
  "Give me a sec...",
  "Working my magic...",
  "Hang tight...",
  "Let me figure this out...",
  "Brewing ideas...",
  "Crunching the numbers...",
  "Just a moment...",
] as const;

const reloadThinkingMessage$ = state(0);

const TOOL_LABELS: Readonly<
  Record<string, (input: Record<string, unknown> | undefined) => string>
> = {
  Bash: () => {
    return "Running a command...";
  },
  Read: (i) => {
    return i?.file_path
      ? `Reading ${basename(String(i.file_path))}`
      : "Peeking at a file...";
  },
  Write: (i) => {
    return i?.file_path
      ? `Writing ${basename(String(i.file_path))}`
      : "Jotting things down...";
  },
  Edit: (i) => {
    return i?.file_path
      ? `Tweaking ${basename(String(i.file_path))}`
      : "Making some edits...";
  },
  Search: () => {
    return "Searching for info...";
  },
  Grep: () => {
    return "Digging through the code...";
  },
  Glob: () => {
    return "Scouting for files...";
  },
  Skill: (i) => {
    return i?.skill ? `Using ${String(i.skill)}` : "Pulling out a trick...";
  },
  WebSearch: (i) => {
    return i?.query
      ? `Looking up "${truncate(String(i.query), 40)}"`
      : "Browsing the web...";
  },
  WebFetch: (i) => {
    return i?.url
      ? `Checking out ${domainFromUrl(String(i.url))}`
      : "Grabbing a page...";
  },
  Agent: () => {
    return "Delegating to a helper...";
  },
  ToolSearch: () => {
    return "Finding the right tool...";
  },
  CodeSearch: () => {
    return "Searching through code...";
  },
  FileSearch: () => {
    return "Looking for files...";
  },
};

function humanizeToolUse(
  name: string,
  input: Record<string, unknown> | undefined,
): string {
  const fn = TOOL_LABELS[name];
  if (fn) {
    return fn(input);
  }
  const readable = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
  return `Working on it (${readable})...`;
}

function summarizeEvent(event: AgentEvent, skipText: boolean): string | null {
  const content = getEventContent(event);
  for (const block of content) {
    if (block.type === "tool_use" && block.name) {
      return humanizeToolUse(block.name, block.input);
    }
    if (!skipText && block.type === "text" && block.text) {
      const line = block.text.split("\n")[0] ?? "";
      return truncate(line, 80);
    }
  }
  return null;
}

/**
 * Signal for talk-page sends that must survive page navigation.
 *
 * The talk page navigates from `/agents/:id/chat` to `/chats/:id` on send,
 * which aborts the page-level signal.  This dedicated signal lets the
 * talk page pass a cancellable AbortSignal without coupling to the page
 * lifecycle.  It is reset each time `startNewZeroSession$` fires (which
 * is called before every talk-page send), so stale controllers are
 * cleaned up automatically.
 */
export const resetTalkSendSignal$ = resetSignal();

export const deleteChatThread$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const threads = await get(chatThreads$);
    signal.throwIfAborted();

    const client = get(zeroClient$)(chatThreadByIdContract);
    await accept(client.delete({ params: { id: threadId } }), [204]);
    signal.throwIfAborted();

    toast.success("Chat deleted");

    if (get(currentChatThreadId$) === threadId) {
      const idx = threads.findIndex((t) => {
        return t.id === threadId;
      });
      const remaining = threads.filter((t) => {
        return t.id !== threadId;
      });
      if (remaining.length === 0) {
        set(detachedNavigateTo$, "/");
      } else {
        const nextThread = remaining[idx] ?? remaining[remaining.length - 1];
        set(navigateToChat$, nextThread.id);
      }
    }

    set(reloadChatThreads$);
  },
);

async function collectAllEvents(
  pages: Computed<Promise<PagedRunEvents>>[],
  get: (c: Computed<Promise<PagedRunEvents>>) => Promise<PagedRunEvents>,
): Promise<AgentEvent[]> {
  const allEvents: AgentEvent[] = [];
  for (const page$ of pages) {
    const page = await get(page$);
    allEvents.push(...page.events);
  }
  return allEvents;
}

/**
 * Extract ALL assistant text outputs from the event stream, in order.
 */
function extractTexts(events: AgentEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.eventType === "assistant") {
      for (const block of getEventContent(event)) {
        if (block.type === "text" && block.text) {
          texts.push(block.text);
        }
      }
    }
  }
  return texts;
}

function extractResult(events: AgentEvent[]): string {
  const texts = extractTexts(events);
  return texts[texts.length - 1] ?? "";
}

function extractSummaries(events: AgentEvent[]): string[] {
  // Segment the timeline by text: only show tool_use activities that happened
  // after the most recent text block. Prior segments' activities are
  // associated with the earlier text bubbles and no longer relevant.
  let startIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (hasTextBlock(events[i])) {
      startIdx = i + 1;
      break;
    }
  }

  const segment = events.slice(startIdx);

  const summaries: string[] = [];
  for (const event of segment) {
    const s = summarizeEvent(event, true);
    if (s) {
      summaries.push(s);
    }
  }
  return summaries;
}

export function createActiveRunMessage(
  runId: string,
  prompt: string,
): { userMessage: UserChatMessage; assistantMessage: AssistantChatMessage } {
  const runLoop = createRunLoop(runId);

  const result$ = computed(async (get) => {
    const pages = await get(runLoop.pagedEventsList$);
    const events = await collectAllEvents(pages, get);
    return extractResult(events);
  });

  const texts$ = computed(async (get) => {
    const pages = await get(runLoop.pagedEventsList$);
    const events = await collectAllEvents(pages, get);
    return extractTexts(events);
  });

  const summaries$ = computed(async (get) => {
    const pages = await get(runLoop.pagedEventsList$);
    const events = await collectAllEvents(pages, get);
    return extractSummaries(events);
  });

  return {
    userMessage: {
      id: `run-user-${runId}`,
      role: "user",
      content: prompt,
    },
    assistantMessage: {
      id: `run-asst-${runId}`,
      role: "assistant",
      legacyRunId: runId,
      runLoop,
      result$,
      texts$,
      summaries$,
    },
  };
}

/**
 * An "active" status means the run is still in progress and the frontend
 * should poll Axiom for live text/tool events. Missing/null status (e.g. a
 * legacy row whose agentRuns row has been purged) is treated as static —
 * NOT active — so the row's stored content renders directly.
 */
function isActiveStatus(status: string | undefined): boolean {
  return status === "queued" || status === "pending" || status === "running";
}

export interface ChatMessages {
  messages: ZeroChatMessage[];
  activeRunMessages: ZeroChatMessage[];
  agentId?: string;
  lastActiveRunId: string | null;
}

/**
 * Transform raw server chat messages into ZeroChatMessage[].
 * Active runs (assistant with runId + non-terminal status) get a runLoop for polling.
 * Returns both the full message list and the active run messages for polling setup.
 *
 * Message ids are derived from the row's stable identifiers (createdAt / runId)
 * rather than random UUIDs. Each poll cycle recomputes this transform; using
 * fresh UUIDs would change React keys every 3s, unmount/remount every message
 * component, and reset per-hook state (e.g. useLastLoadable's resolved-value
 * ref) — which surfaced as the activity line flashing from "Running a
 * command..." to "Just a moment..." on every poll.
 */
export function transformServerMessages(
  rawMessages: ChatThread["chatMessages"],
): {
  messages: ZeroChatMessage[];
  activeRunMessages: ZeroChatMessage[];
  lastActiveRunId: string | null;
} {
  // Pre-compute: for each active run (status === pending | running), pick
  // the row index that will carry the reactive bubble. While a run is
  // active the source of truth is Axiom (via runLoop.texts$), not the
  // chat_messages table — the event consumer is still filling rows in, and
  // rendering those rows alongside texts$ would duplicate every text block.
  //
  // We pick the FIRST assistant row for the run as the anchor and skip the
  // rest. The anchor produces a single reactive message whose texts$ renders
  // every assistant text from the run event stream.
  const activeRunAnchorIndex = new Map<string, number>();
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    if (
      m.role === "assistant" &&
      m.runId &&
      isActiveStatus(m.status) &&
      !activeRunAnchorIndex.has(m.runId)
    ) {
      activeRunAnchorIndex.set(m.runId, i);
    }
  }

  const messages: ZeroChatMessage[] = [];
  const activeRunMessages: ZeroChatMessage[] = [];
  let lastActiveRunId: string | null = null;

  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];

    if (m.role === "user") {
      const userMsg: UserChatMessage = {
        id: `user:${m.createdAt}`,
        role: "user",
        content: m.content ?? "",
        createdAt: m.createdAt,
      };
      messages.push(userMsg);
      continue;
    }

    // Anchor row for an active run → create polling loop (Axiom-driven)
    if (m.runId && activeRunAnchorIndex.get(m.runId) === i) {
      const { assistantMessage } = createActiveRunMessage(m.runId, "");
      // Override the random id with a stable one keyed on the run itself —
      // there is exactly one reactive bubble per active run regardless of
      // how many DB rows back it — so the key survives across poll cycles.
      assistantMessage.id = `run:${m.runId}`;
      messages.push(assistantMessage);
      activeRunMessages.push(assistantMessage);
      lastActiveRunId = m.runId;
      continue;
    }

    // Non-anchor row for an active run → skip. While the run is active the
    // reactive bubble (anchor) already renders every text via texts$; showing
    // filled-in rows would duplicate the same content.
    if (m.runId && activeRunAnchorIndex.has(m.runId)) {
      continue;
    }

    // Static assistant message (terminal run, or no run).
    messages.push({
      id: `assistant:${m.createdAt}`,
      role: "assistant" as const,
      result$: computed(() => {
        return Promise.resolve(m.content ?? "");
      }),
      legacyRunId: m.runId,
      ...(m.error ? { status: "failed" as const, error: m.error } : {}),
      createdAt: m.createdAt,
    });
  }

  return { messages, activeRunMessages, lastActiveRunId };
}

const chatMessages$ = computed(async (get): Promise<ChatMessages | null> => {
  const thread = await get(currentChatThread$);
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

export const loadChatMessages$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    L.debug("Loading messages");
    const ablyNotify = get(ablyNotify$);
    const messages = await get(chatMessages$);
    signal.throwIfAborted();
    if (!messages?.activeRunMessages.length) {
      return;
    }

    set(internalLocalMessages$, messages.activeRunMessages);

    const assistantMessages = messages.activeRunMessages.filter(
      (m): m is AssistantChatMessage => {
        return m.role === "assistant";
      },
    );

    if (assistantMessages.length === 0) {
      set(reloadChatThreads$);
      set(reloadCurrentChatThread$);
      return;
    }

    await Promise.all(
      assistantMessages.map(async (message) => {
        const runLoop = message.runLoop;
        if (!runLoop?.checkFinished$) {
          return;
        }

        set(markMessageLoading$, message.legacyRunId!);

        await ablyNotify(
          `thread:${message.legacyRunId}`,
          (sig) => {
            set(reloadThinkingMessage$, (x) => {
              return x + 1;
            });
            return set(runLoop.checkFinished$, sig);
          },
          3000,
          signal,
        );

        const content = await get(message.result$);
        signal.throwIfAborted();
        if (content) {
          await set(checkAutoRead$, message.legacyRunId!, content, signal);
        }

        set(reloadChatThreads$);
        set(reloadCurrentChatThread$);
      }),
    );
    signal.throwIfAborted();
  },
);

export const startNewZeroSession$ = command(({ set }) => {
  set(resetTalkSendSignal$);
  set(internalLocalMessages$, []);
});

const internalCreatingPromise$ = state<Promise<string | null> | undefined>(
  undefined,
);

export const creatingNewSession$ = computed(async (get) => {
  await get(internalCreatingPromise$);
});

const internalCreateNewChatSession$ = command(
  async (
    { get, set },
    agentComposeId: string | null,
    _signal: AbortSignal,
  ): Promise<string | null> => {
    const resolvedComposeId =
      agentComposeId ?? (await get(zeroOnboardingStatus$)).defaultAgentId;

    if (!resolvedComposeId) {
      toast.error("No agent available for new chat session");
      return null;
    }

    // A1: If currently viewing an empty thread for this agent, reuse it
    const currentThread = await get(currentChatThread$);
    if (
      currentThread &&
      currentThread.agentId === resolvedComposeId &&
      currentThread.chatMessages.length === 0
    ) {
      set(startNewZeroSession$);
      return currentThread.id;
    }

    // A2: If the first thread in the list is empty, reuse it
    const threads = await get(chatThreads$);
    const firstThread = threads[0];
    if (
      firstThread?.title === null &&
      firstThread.agentId === resolvedComposeId
    ) {
      set(startNewZeroSession$);
      return firstThread.id;
    }

    // Fallback: create a new thread
    set(startNewZeroSession$);

    const createClient = get(zeroClient$);
    const thread = await createChatThread(createClient, resolvedComposeId);

    set(reloadChatThreads$);
    return thread.id;
  },
);

export const createNewChatThread$ = command(
  (
    { set },
    agentComposeId: string | null,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const promise = set(internalCreateNewChatSession$, agentComposeId, signal);
    set(internalCreatingPromise$, promise);
    return promise;
  },
);

const prepareUserMessage$ = command(
  async (
    { get },
    prompt: string,
    signal: AbortSignal,
  ): Promise<{
    fullPrompt: string;
    userMessage: UserChatMessage;
    draft: DraftSignals | null;
  } | null> => {
    const draft = get(currentDraft$);
    const allAttachments = draft ? get(draft.attachments$) : [];
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

    // Guard: nothing to send (no text and no ready attachments)
    if (!prompt.trim() && ready.length === 0) {
      return null;
    }

    const attachmentLines = ready.map((r) => {
      return `[Attached file: ${r.attachment.filename}](${r.info.url})\nDownload with: curl -sL -o "${r.attachment.filename}" "${r.info.url}"`;
    });

    // Build fullPrompt without leading \n\n when text is empty
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
    return { fullPrompt, userMessage, draft };
  },
);

interface ChatMessageArgs {
  agentId: string;
  prompt: string;
  threadId?: string;
  hasTextContent: boolean;
}

const prepareChatMessage$ = command(
  async (
    { set },
    agentId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<ChatMessageArgs | null> => {
    const result = await set(prepareUserMessage$, prompt, signal);
    if (!result) {
      return null;
    }
    signal.throwIfAborted();

    set(internalLocalMessages$, (prev) => {
      return [...prev, result.userMessage];
    });

    // Clear the draft after preparing the message
    if (result.draft) {
      set(result.draft.clear$);
    }

    const trimmedPrompt = prompt.trim();
    return {
      agentId,
      prompt: result.fullPrompt,
      hasTextContent: trimmedPrompt.length > 0,
    };
  },
);

const sendChatMessageRequest$ = command(
  async (
    { get },
    message: ChatMessageArgs,
    signal: AbortSignal,
  ): Promise<{ threadId: string; runId: string }> => {
    const client = get(zeroClient$)(chatMessagesContract);
    const result = await accept(
      client.send({ body: message, fetchOptions: { signal } }),
      [201],
    );
    signal.throwIfAborted();
    return result.body;
  },
);

export const sendNewThreadMessage$ = command(
  async (
    { set },
    agentId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const message = await set(prepareChatMessage$, agentId, prompt, signal);
    if (!message) {
      return null;
    }

    const { threadId } = await set(sendChatMessageRequest$, message, signal);

    set(reloadChatThreads$);
    return threadId;
  },
);

export const sendExistingThreadMessage$ = command(
  async ({ get, set }, prompt: string, signal: AbortSignal) => {
    const threadId = get(currentChatThreadId$);
    const thread = await get(currentChatThread$);
    signal.throwIfAborted();
    const agentId = thread?.agentId;

    if (!threadId || !agentId) {
      return;
    }

    const message = await set(prepareChatMessage$, agentId, prompt, signal);
    if (!message) {
      return;
    }

    const { runId } = await set(
      sendChatMessageRequest$,
      {
        ...message,
        threadId,
      },
      signal,
    );

    set(reloadChatThreads$);
    set(reloadCurrentChatThread$);

    const { assistantMessage } = createActiveRunMessage(runId, prompt);
    set(internalLocalMessages$, (prev) => {
      return [...prev, assistantMessage];
    });

    set(markMessageLoading$, assistantMessage.legacyRunId!);

    const runLoop = assistantMessage.runLoop;
    if (!runLoop) {
      return;
    }

    const ablyNotify = get(ablyNotify$);
    await ablyNotify(
      `thread:${runId}`,
      (sig) => {
        set(reloadChatThreads$);
        set(reloadCurrentChatThread$);
        return set(runLoop.checkFinished$, sig);
      },
      3000,
      signal,
    );

    // After the poll loop exits, the last `reloadCurrentChatThread$` ran at
    // the START of the final iteration — at that point the run's server-side
    // status was still "queued"/"running", so `transformServerMessages`
    // picked the assistant row as an active anchor and attached a fresh
    // runLoop whose `detail$` cached that stale status. Without one more
    // reload, the anchor's runLoop would stay stuck at the stale status,
    // keeping `MessageRunActivityLine` mounted — which renders the
    // "Thinking..." loader indefinitely whenever `summaries$` happens to be
    // empty.
    set(reloadChatThreads$);
    set(reloadCurrentChatThread$);

    const content = await get(assistantMessage.result$);
    signal.throwIfAborted();
    if (content) {
      await set(checkAutoRead$, assistantMessage.legacyRunId!, content, signal);
    }
  },
);

// ---------------------------------------------------------------------------
// Composer local UI state
// ---------------------------------------------------------------------------

const internalComposerFileInput$ = state<HTMLElement | null>(null);

export const composerFileInput$ = computed((get) => {
  return get(internalComposerFileInput$);
});

export const setComposerFileInput$ = onRef(
  command(({ set }, el: HTMLElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(internalComposerFileInput$, null);
    });
    set(internalComposerFileInput$, el);
  }),
);
