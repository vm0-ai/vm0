import { command, computed, state, type Computed } from "ccstate";
import type { AgentEvent, LogStatus } from "./log-types.ts";
import { resetSignal, throwIfAbort } from "../utils.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { logger } from "../log.ts";
import {
  currentDraft$,
  talkDraft$,
  type ZeroChatAttachment,
} from "./chat-draft.ts";
import {
  createRunLoop,
  fibDelays$,
  pollInterval$,
  setLoop,
  type PagedRunEvents,
} from "./polling.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import {
  navigateToChat$,
  chatThreadId$,
  sidebarChatAgentId$,
} from "./zero-nav.ts";
import {
  RUN_ERROR_GUIDANCE,
  chatMessagesContract,
  chatThreadsContract,
  chatThreadByIdContract,
  zeroSessionsByIdContract,
  type SummaryEntry,
} from "@vm0/core";
import { accept, ApiError } from "../../lib/accept.ts";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";

export {
  zeroChatInput$,
  setZeroChatInput$,
  clearZeroChatInput$,
  zeroChatAttachments$,
  uploadZeroAttachment$,
  removeZeroAttachment$,
  zeroDragOver$,
  setZeroDragOver$,
  type ZeroChatAttachment,
} from "./chat-draft.ts";

const L = logger("ZeroChat");

function isResultEventData(data: unknown): data is { result: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "result" in data &&
    typeof (data as { result: unknown }).result === "string"
  );
}

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
  summaries?: string[];
  runLoop?: ReturnType<typeof createRunLoop>;
  summaries$?: Computed<Promise<string[]>>;
  createdAt?: string;
}

export type ZeroChatMessage = UserChatMessage | AssistantChatMessage;

const internalLocalMessages$ = state<ZeroChatMessage[]>([]);

export const resetLocalMessages$ = command(({ set }) => {
  set(internalLocalMessages$, []);
});

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
function createPlaceholderAssistantMessage(
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
  const snapshot = await get(chatSessionSnapshot$);
  const serverMessages = snapshot?.messages ?? [];
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

/** Cancel the currently active run. */
export const cancelActiveRun$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Find the active assistant message with a runLoop
    const local = get(internalLocalMessages$);
    const activeMsg = [...local]
      .reverse()
      .find((m): m is AssistantChatMessage => {
        return m.role === "assistant" && !!m.runLoop;
      });
    if (!activeMsg?.runLoop) {
      return;
    }

    await set(activeMsg.runLoop.cancel$, signal);
  },
);

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

const THINKING_MESSAGES = [
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
export const thinkingMessage$ = computed((get) => {
  get(reloadThinkingMessage$);
  return THINKING_MESSAGES[
    Math.floor(Math.random() * THINKING_MESSAGES.length)
  ];
});

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

const internalReloadChatThreads$ = state(0);

export const reloadChatThreads$ = command(({ set }) => {
  set(internalReloadChatThreads$, (n) => {
    return n + 1;
  });
});

export const chatThreads$ = computed(async (get) => {
  get(internalReloadChatThreads$);
  const sidebarAgentId = get(sidebarChatAgentId$);
  const composeId =
    sidebarAgentId ?? (await get(zeroOnboardingStatus$)).defaultAgentId;
  if (!composeId) {
    return [];
  }
  const client = get(zeroClient$)(chatThreadsContract);
  const result = await accept(
    client.list({ query: { agentId: composeId } }),
    [200],
    { toast: false },
  );
  const threads = result.body.threads;

  const currentThread = await get(currentChatThread$);
  return threads.map((t) => {
    return {
      ...t,
      title:
        t.id === currentThread?.id ? t.title || currentThread.title : t.title,
    };
  });
});

export const deleteChatThread$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const threadSnapshot = await get(chatThreads$);
    signal.throwIfAborted();

    const client = get(zeroClient$)(chatThreadByIdContract);
    await accept(client.delete({ params: { id: threadId } }), [204]);
    signal.throwIfAborted();

    toast.success("Chat deleted");

    if (get(chatThreadId$) === threadId) {
      const idx = threadSnapshot.findIndex((t) => {
        return t.id === threadId;
      });
      const remaining = threadSnapshot.filter((t) => {
        return t.id !== threadId;
      });
      if (remaining.length === 0) {
        set(detachedNavigateTo$, "/");
      } else {
        const nextThread = remaining[idx] ?? remaining[remaining.length - 1];
        set(navigateToChat$, nextThread.id);
      }
    }

    set(internalReloadChatThreads$, (n) => {
      return n + 1;
    });
  },
);

interface ChatThread {
  id: string;
  agentId?: string;
  title: string | null;
  chatMessages: {
    role: "user" | "assistant";
    content: string;
    runId?: string;
    error?: string;
    summaries?: SummaryEntry[];
    createdAt: string;
  }[];
  latestSessionId: string | null;
  unsavedRuns: {
    runId: string;
    status: string;
    prompt: string;
    error: string | null;
    createdAt: string;
  }[];
  isLegacySession: boolean;
}

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

function extractResult(events: AgentEvent[]): string {
  let result = "";
  for (const event of events) {
    if (event.eventType === "result" && isResultEventData(event.eventData)) {
      result = event.eventData.result;
    }
  }
  return result;
}

function extractSummaries(events: AgentEvent[]): string[] {
  let lastTextIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (hasTextBlock(events[i])) {
      lastTextIdx = i;
      break;
    }
  }
  const summaries: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const s = summarizeEvent(events[i], i === lastTextIdx);
    if (s) {
      summaries.push(s);
    }
  }
  return summaries;
}

function createActiveRunMessage(
  runId: string,
  prompt: string,
): { userMessage: UserChatMessage; assistantMessage: AssistantChatMessage } {
  const runLoop = createRunLoop(runId);

  const result$ = computed(async (get) => {
    const pages = await get(runLoop.pagedEventsList$);
    const events = await collectAllEvents(pages, get);
    return extractResult(events);
  });

  const summaries$ = computed(async (get) => {
    const pages = await get(runLoop.pagedEventsList$);
    const events = await collectAllEvents(pages, get);
    return extractSummaries(events);
  });

  return {
    userMessage: {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
    },
    assistantMessage: {
      id: crypto.randomUUID(),
      role: "assistant",
      legacyRunId: runId,
      runLoop,
      result$,
      summaries$,
    },
  };
}

function unsavedRunsToMessages(unsavedRuns: ChatThread["unsavedRuns"]): {
  messages: ZeroChatMessage[];
  activeRunMessages: ZeroChatMessage[];
  lastActiveRunId: string | null;
} {
  const messages: ZeroChatMessage[] = [];
  const activeRunMessages: ZeroChatMessage[] = [];
  let lastActiveRunId: string | null = null;

  for (const run of unsavedRuns) {
    const isCancelled = run.status === "cancelled";
    const isFailed =
      run.status === "failed" || run.status === "timeout" || isCancelled;
    if (isFailed) {
      messages.push({
        id: crypto.randomUUID(),
        role: "user",
        content: run.prompt,
        createdAt: run.createdAt,
      });
      messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        result$: computed(() => {
          return Promise.resolve("");
        }),
        legacyRunId: run.runId,
        status: "failed",
        error: isCancelled
          ? "Run cancelled."
          : (run.error ??
            "Something went wrong. Check the activity logs for details."),
        createdAt: run.createdAt,
      });
    } else {
      const { userMessage, assistantMessage } = createActiveRunMessage(
        run.runId,
        run.prompt,
      );
      activeRunMessages.push(userMessage);
      activeRunMessages.push(assistantMessage);
      lastActiveRunId = run.runId;
    }
  }

  return { messages, activeRunMessages, lastActiveRunId };
}

interface ChatSessionSnapshotData {
  messages: ZeroChatMessage[];
  activeRunMessages: ZeroChatMessage[];
  agentId?: string;
  lastActiveRunId: string | null;
}

const reloadCurrentThread$ = state(0);

export const currentChatThread$ = computed(
  async (get): Promise<ChatThread | null> => {
    get(reloadCurrentThread$);
    const threadId = get(chatThreadId$);
    if (!threadId) {
      return null;
    }

    const threadClient = get(zeroClient$)(chatThreadByIdContract);
    try {
      const threadResult = await accept(
        threadClient.get({ params: { id: threadId } }),
        [200],
        { toast: false },
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
    } catch (error) {
      throwIfAbort(error);
      // not a thread; try session lookup below
    }

    const sessionClient = get(zeroClient$)(zeroSessionsByIdContract);
    try {
      const sessionResult = await accept(
        sessionClient.getById({ params: { id: threadId } }),
        [200],
        { toast: false },
      );
      const body = sessionResult.body;
      return {
        id: threadId,
        title: null,
        agentId: body.agentId,
        chatMessages: body.chatMessages ?? [],
        latestSessionId: threadId,
        unsavedRuns: [],
        isLegacySession: true,
      };
    } catch (error) {
      throwIfAbort(error);
      L.warn("Failed to load chat");
      return null;
    }
  },
);

const currentChatMessages$ = computed(
  async (get): Promise<ZeroChatMessage[]> => {
    const messages = (await get(currentChatThread$))?.chatMessages ?? [];

    return messages.map((m) => {
      const summaries =
        m.summaries && m.summaries.length > 0
          ? m.summaries.map((s) => {
              if (typeof s === "string") {
                return TOOL_LABELS[s] ? humanizeToolUse(s, undefined) : s;
              }
              if (s.kind === "tool") {
                return humanizeToolUse(s.name, s.input);
              }
              return s.text;
            })
          : undefined;

      const base = {
        id: crypto.randomUUID(),
        ...(summaries && summaries.length > 0 ? { summaries } : {}),
      };

      if (m.role === "user") {
        return {
          ...base,
          role: "user" as const,
          content: m.content,
          createdAt: m.createdAt,
        };
      }

      return {
        ...base,
        role: "assistant" as const,
        result$: computed(() => {
          return Promise.resolve(m.content);
        }),
        legacyRunId: m.runId,
        ...(m.error ? { status: "failed" as const, error: m.error } : {}),
        createdAt: m.createdAt,
      };
    });
  },
);

const chatSessionSnapshot$ = computed(
  async (get): Promise<ChatSessionSnapshotData | null> => {
    const thread = await get(currentChatThread$);
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
  },
);

export const loadSessionFromSnapshot$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    L.debug("Loading session from snapshot");
    const snapshot = await get(chatSessionSnapshot$);
    signal.throwIfAborted();
    if (!snapshot?.activeRunMessages.length) {
      return;
    }

    set(internalLocalMessages$, snapshot.activeRunMessages);

    const assistantMessages = snapshot.activeRunMessages.filter(
      (m): m is AssistantChatMessage => {
        return m.role === "assistant";
      },
    );

    if (assistantMessages.length === 0) {
      set(internalReloadChatThreads$, (n) => {
        return n + 1;
      });
      set(reloadCurrentThread$, (n) => {
        return n + 1;
      });
      return;
    }

    await Promise.all(
      assistantMessages.map(async (message) => {
        const runLoop = message.runLoop;
        if (!runLoop?.checkFinished$) {
          return;
        }

        await setLoop(
          async (sig) => {
            const finished = await set(runLoop.checkFinished$, sig);
            if (!finished) {
              set(reloadThinkingMessage$, (x) => {
                return x + 1;
              });
            }
            return finished;
          },
          get(pollInterval$),
          signal,
          get(fibDelays$),
        );

        set(internalReloadChatThreads$, (x) => {
          return x + 1;
        });
        set(reloadCurrentThread$, (n) => {
          return n + 1;
        });
      }),
    );
    signal.throwIfAborted();
  },
);

export const startNewZeroSession$ = command(({ get, set }) => {
  set(resetTalkSendSignal$);
  set(internalLocalMessages$, []);
  set(get(talkDraft$).clear$);
});

const internalCreatingPromise$ = state<Promise<void> | undefined>(undefined);

export const creatingNewSession$ = computed(async (get) => {
  await get(internalCreatingPromise$);
});

const internalCreateNewChatSession$ = command(
  async ({ get, set }, agentComposeId: string | null, _signal: AbortSignal) => {
    const resolvedComposeId =
      agentComposeId ?? (await get(zeroOnboardingStatus$)).defaultAgentId;

    if (!resolvedComposeId) {
      toast.error("No agent available for new chat session");
      return;
    }

    // A1: If currently viewing an empty thread for this agent, reuse it
    const currentThread = await get(currentChatThread$);
    if (
      currentThread &&
      currentThread.agentId === resolvedComposeId &&
      currentThread.chatMessages.length === 0 &&
      currentThread.unsavedRuns.length === 0
    ) {
      set(startNewZeroSession$);
      return;
    }

    // A2: If an empty thread already exists in the list, navigate to it
    const threads = await get(chatThreads$);
    const emptyThread = threads.find((t) => {
      return t.title === null && t.agentId === resolvedComposeId;
    });
    if (emptyThread) {
      set(startNewZeroSession$);
      set(navigateToChat$, emptyThread.id);
      return;
    }

    // Fallback: create a new thread
    set(startNewZeroSession$);

    const createClient = get(zeroClient$);
    const thread = await createChatThread(createClient, resolvedComposeId);

    set(reloadChatThreads$);
    set(navigateToChat$, thread.id);
  },
);

export const createNewChatThread$ = command(
  ({ set }, agentComposeId: string | null, signal: AbortSignal) => {
    const promise = set(internalCreateNewChatSession$, agentComposeId, signal);
    set(internalCreatingPromise$, promise);
    return promise;
  },
);

const prepareUserMessage$ = command(
  async (
    { get, set },
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ fullPrompt: string }> => {
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

    let fullPrompt = prompt.trim();
    if (ready.length > 0) {
      const lines = ready.map((r) => {
        return `[Attached file: ${r.attachment.filename}](${r.info.url})\nDownload with: curl -sL -o "${r.attachment.filename}" "${r.info.url}"`;
      });
      fullPrompt = `${fullPrompt}\n\n${lines.join("\n")}`;
    }

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
    set(internalLocalMessages$, (prev) => {
      return [...prev, userMessage];
    });

    // Clear the draft after preparing the message
    if (draft) {
      set(draft.clear$);
    }

    return { fullPrompt };
  },
);

interface ChatMessageArgs {
  agentId: string;
  prompt: string;
  threadId?: string;
}

const prepareChatMessage$ = command(
  async (
    { set },
    agentId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<ChatMessageArgs | null> => {
    if (!prompt.trim()) {
      return null;
    }

    const { fullPrompt } = await set(prepareUserMessage$, prompt, signal);
    signal.throwIfAborted();

    return {
      agentId,
      prompt: fullPrompt,
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
    try {
      const result = await accept(
        client.send({ body: message, fetchOptions: { signal } }),
        [201],
      );
      signal.throwIfAborted();
      return result.body;
    } catch (error) {
      throwIfAbort(error);
      if (error instanceof ApiError) {
        const guidance = error.code
          ? RUN_ERROR_GUIDANCE[error.code]
          : undefined;
        if (guidance) {
          throw new Error(`${guidance.title}: ${guidance.guidance}`);
        }
      }
      throw error;
    }
  },
);

export const sendNewThreadMessage$ = command(
  async ({ set }, agentId: string, prompt: string, signal: AbortSignal) => {
    const message = await set(prepareChatMessage$, agentId, prompt, signal);
    if (!message) {
      return;
    }

    const { threadId } = await set(sendChatMessageRequest$, message, signal);

    set(reloadChatThreads$);
    set(navigateToChat$, threadId);
  },
);

export const sendExistingThreadMessage$ = command(
  async ({ get, set }, prompt: string, signal: AbortSignal) => {
    const threadId = get(chatThreadId$);
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

    set(internalReloadChatThreads$, (n) => {
      return n + 1;
    });
    set(reloadCurrentThread$, (n) => {
      return n + 1;
    });

    const { assistantMessage } = createActiveRunMessage(runId, prompt);
    set(internalLocalMessages$, (prev) => {
      return [...prev, assistantMessage];
    });

    const runLoop = assistantMessage.runLoop;
    if (!runLoop) {
      return;
    }

    await setLoop(
      async (sig) => {
        const finished = await set(runLoop.checkFinished$, sig);
        if (!finished) {
          set(internalReloadChatThreads$, (n) => {
            return n + 1;
          });
          set(reloadCurrentThread$, (n) => {
            return n + 1;
          });
        }
        return finished;
      },
      get(pollInterval$),
      signal,
      get(fibDelays$),
    );
  },
);

// ---------------------------------------------------------------------------
// Composer local UI state
// ---------------------------------------------------------------------------

const internalComposerFileInput$ = state<HTMLElement | null>(null);

export const composerFileInput$ = computed((get) => {
  return get(internalComposerFileInput$);
});

export const setComposerFileInput$ = command(
  ({ set }, el: HTMLElement | null) => {
    set(internalComposerFileInput$, el);
  },
);
