import { command, computed, state, type Command, type Computed } from "ccstate";
import { delay } from "signal-timers";
import type { AgentEvent, LogStatus } from "./log-types.ts";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort, resetSignal, createDeferredPromise } from "../utils.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { logger } from "../log.ts";
import {
  createRunLoop,
  poolInterval$,
  type PagedRunEvents,
} from "./polling.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import {
  navigateToChat$,
  chatThreadId$,
  sidebarChatAgentId$,
} from "./zero-nav.ts";
import { currentAgentId$ } from "./agent.ts";
import {
  RUN_ERROR_GUIDANCE,
  chatMessagesContract,
  chatThreadsContract,
  chatThreadByIdContract,
  zeroSessionsByIdContract,
  type SummaryEntry,
} from "@vm0/core";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";
import { defaultAgentId$ } from "./zero-agent-name.ts";

const L = logger("ZeroChat");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard for event data containing a result string. */
function isResultEventData(data: unknown): data is { result: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "result" in data &&
    typeof (data as { result: unknown }).result === "string"
  );
}

/** Scan telemetry event pages for the last "result" event content. */

/** Create a chat thread via the threads API. Used by the "New chat" sidebar button. */
async function createChatThread(
  createClient: ZeroClientFactory,
  agentId: string,
  title?: string,
): Promise<{ id: string; title: string | null }> {
  const client = createClient(chatThreadsContract);
  const result = await client.create({
    body: { agentId, ...(title ? { title } : {}) },
  });
  if (result.status !== 201) {
    throw new Error("Failed to create chat thread");
  }
  return { id: result.body.id, title: result.body.title };
}

// ---------------------------------------------------------------------------
// Chat message types
// ---------------------------------------------------------------------------

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
}

export interface AssistantChatMessage {
  id: string;
  role: "assistant";
  content: string;
  legacyRunId?: string;
  status?: LogStatus;
  error?: string;
  cancelled?: boolean;
  summaries?: string[];
  runLoop?: ReturnType<typeof createRunLoop>;
  /** Reactive result content derived from runLoop events. */
  result$?: Computed<Promise<string>>;
  /** Reactive summaries derived from runLoop events. */
  summaries$?: Computed<Promise<string[]>>;
  /** Command to start the polling loop for this run. */
  beginLoop$?: ReturnType<typeof createRunLoop>["beginLoop$"];
}

export type ZeroChatMessage = UserChatMessage | AssistantChatMessage;

const internalLocalMessages$ = state<ZeroChatMessage[]>([]);

export const resetLocalMessages$ = command(({ set }) => {
  set(internalLocalMessages$, []);
});

export const zeroChatMessages$ = computed(async (get) => {
  const snapshot = await get(chatSessionSnapshot$);
  const serverMessages = snapshot?.messages ?? [];
  const localMessages = get(internalLocalMessages$);
  return [...serverMessages, ...localMessages];
});

/** Whether all runs have finished (no in-flight runs). */
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
      .find(
        (m): m is AssistantChatMessage => m.role === "assistant" && !!m.runLoop,
      );
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
  return getEventContent(event).some((b) => b.type === "text" && b.text);
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

const TOOL_LABELS: Readonly<
  Record<string, (input: Record<string, unknown> | undefined) => string>
> = {
  Bash: () => "Running a command...",
  Read: (i) =>
    i?.file_path
      ? `Reading ${basename(String(i.file_path))}`
      : "Peeking at a file...",
  Write: (i) =>
    i?.file_path
      ? `Writing ${basename(String(i.file_path))}`
      : "Jotting things down...",
  Edit: (i) =>
    i?.file_path
      ? `Tweaking ${basename(String(i.file_path))}`
      : "Making some edits...",
  Search: () => "Searching for info...",
  Grep: () => "Digging through the code...",
  Glob: () => "Scouting for files...",
  Skill: (i) =>
    i?.skill ? `Using ${String(i.skill)}` : "Pulling out a trick...",
  WebSearch: (i) =>
    i?.query
      ? `Looking up "${truncate(String(i.query), 40)}"`
      : "Browsing the web...",
  WebFetch: (i) =>
    i?.url
      ? `Checking out ${domainFromUrl(String(i.url))}`
      : "Grabbing a page...",
  Agent: () => "Delegating to a helper...",
  ToolSearch: () => "Finding the right tool...",
  CodeSearch: () => "Searching through code...",
  FileSearch: () => "Looking for files...",
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
 * The talk page navigates from `/talk/` to `/chat/:chatThreadId` on send,
 * which aborts the page-level signal.  This dedicated signal lets the
 * talk page pass a cancellable AbortSignal without coupling to the page
 * lifecycle.  It is reset each time `startNewZeroSession$` fires (which
 * is called before every talk-page send), so stale controllers are
 * cleaned up automatically.
 */
export const resetTalkSendSignal$ = resetSignal();

// ---------------------------------------------------------------------------
// Promise signals — UI derives busy state from these via useLoadable
// ---------------------------------------------------------------------------

// Chat thread list — reload + computed pattern
const reloadChatThreadList$ = state(0);

export const fetchZeroSessionList$ = command(
  ({ set }, _signal: AbortSignal) => {
    set(reloadChatThreadList$, (n) => n + 1);
  },
);

// NOTE: Intentional divergence from sendZeroChatMessage$.
// The thread list in the sidebar must reflect the *last visited* agent (sidebarChatAgentId$),
// which persists across non-chat pages (e.g. /activity) so the user always sees the
// threads for the agent they were talking to.  sendZeroChatMessage$ re-derives the agent
// from the URL / thread at send time because it needs to know the authoritative agent
// for the run being created, not what the sidebar is showing.
const chatThreadListResponse$ = computed(async (get) => {
  get(reloadChatThreadList$);
  const sidebarAgentId = get(sidebarChatAgentId$);
  const composeId =
    sidebarAgentId ?? (await get(zeroOnboardingStatus$)).defaultAgentId;
  if (!composeId) {
    return [];
  }
  const client = get(zeroClient$)(chatThreadsContract);
  const result = await client.list({ query: { agentId: composeId } });
  if (result.status !== 200) {
    throw new Error(`Failed to load chats (${result.status})`);
  }
  return result.body.threads;
});

// Backward-compatible aliases (will be removed)
export const zeroSessionList$ = computed(async (get) => {
  return await get(chatThreadListResponse$);
});

export const zeroSessionListLoading$ = computed(() => false);
export const zeroSessionListError$ = computed(() => null as string | null);

// ---------------------------------------------------------------------------
// Session snapshot — async computed derived from URL
// ---------------------------------------------------------------------------

/** Raw thread/session data returned by the API. */
interface ChatThreadData {
  agentId?: string;
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
  }[];
  isLegacySession: boolean;
}

/** Collect all events from paged event lists into a flat array. */
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

/** Extract result content from a flat list of events. */
function extractResult(events: AgentEvent[]): string {
  let result = "";
  for (const event of events) {
    if (event.eventType === "result" && isResultEventData(event.eventData)) {
      result = event.eventData.result;
    }
  }
  return result;
}

/** Extract summary strings from a flat list of events. */
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

/**
 * Create a pair of messages (user + assistant) for an active run.
 * The assistant message carries reactive signals for result, summaries,
 * and polling control — no external state management needed.
 */
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
      content: "",
      legacyRunId: runId,
      runLoop,
      result$,
      summaries$,
      beginLoop$: runLoop.beginLoop$,
    },
  };
}

/** Splits unsaved runs into completed (failed/cancelled) messages and active run messages. */
function unsavedRunsToMessages(unsavedRuns: ChatThreadData["unsavedRuns"]): {
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
      });
      messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        legacyRunId: run.runId,
        status: "failed",
        error: isCancelled
          ? "Run cancelled."
          : (run.error ??
            "Something went wrong. Check the activity logs for details."),
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
  /** Completed/failed messages — immutable, rendered directly from snapshot. */
  messages: ZeroChatMessage[];
  /** Active run prompt + placeholder — copied to local state for mutable polling updates. */
  activeRunMessages: ZeroChatMessage[];
  agentId?: string;
  lastActiveRunId: string | null;
}

/**
 * Fetches raw thread/session data from the API whenever the URL thread ID changes.
 * Tries the new chat-thread endpoint first, falls back to the legacy session endpoint.
 */
const reloadCurrentThread$ = state(0);

export const currentChatThread$ = computed(
  async (get): Promise<ChatThreadData | null> => {
    get(reloadCurrentThread$);
    const threadId = get(chatThreadId$);
    if (!threadId) {
      return null;
    }

    const threadClient = get(zeroClient$)(chatThreadByIdContract);
    const threadResult = await threadClient.get({
      params: { id: threadId },
    });

    if (threadResult.status === 200) {
      const body = threadResult.body;
      return {
        agentId: body.agentId,
        chatMessages: body.chatMessages ?? [],
        latestSessionId: body.latestSessionId ?? null,
        unsavedRuns: body.unsavedRuns ?? [],
        isLegacySession: false,
      };
    }

    const sessionClient = get(zeroClient$)(zeroSessionsByIdContract);
    const sessionResult = await sessionClient.getById({
      params: { id: threadId },
    });
    if (sessionResult.status !== 200) {
      L.warn("Failed to load chat");
      return null;
    }
    const body = sessionResult.body;
    return {
      agentId: body.agentId,
      chatMessages: body.chatMessages ?? [],
      latestSessionId: threadId,
      unsavedRuns: [],
      isLegacySession: true,
    };
  },
);

/** Transforms raw chat messages into display-ready ZeroChatMessage objects. */
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

      return {
        id: crypto.randomUUID(),
        role: m.role,
        content: m.content,
        legacyRunId: m.runId,
        ...(summaries && summaries.length > 0 ? { summaries } : {}),
        ...(m.error ? { status: "failed" as const, error: m.error } : {}),
      };
    });
  },
);

/**
 * Composes the full session snapshot from thread data + transformed messages.
 * Loading/error states are derived automatically via `useLoadable` in the view.
 */
export const chatSessionSnapshot$ = computed(
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

    return {
      messages: [...(await get(currentChatMessages$)), ...runMessages],
      activeRunMessages,
      agentId: thread.agentId,
      lastActiveRunId: legacyLastActiveRunId,
    };
  },
);

/**
 * @deprecated Use `useLoadable(chatSessionSnapshot$)` in views instead.
 * Kept for test backward compatibility — will be removed.
 */
export const prepareSessionSwitch$ = command(({ set }) => {
  set(internalLocalMessages$, []);
});

/**
 * @deprecated Derive from `useLoadable(chatSessionSnapshot$).state === "hasError"`.
 */
export const zeroSessionError$ = computed(() => null as string | null);

// Chat input
const internalChatInput$ = state("");
export const zeroChatInput$ = computed((get) => get(internalChatInput$));

export const setZeroChatInput$ = command(({ set }, value: string) => {
  set(internalChatInput$, value);
});

export const clearZeroChatInput$ = command(({ set }) => {
  set(internalChatInput$, "");
});

// Attachments
interface FileInfo {
  id: string;
  url: string;
}

export interface ZeroChatAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Reactive file info (id + url) — loading while uploading, hasData when done. */
  fileInfo$: Computed<Promise<FileInfo | null>>;
  /** Cancel the in-flight upload. Always safe to call (no-op if already completed). */
  cancel$: Command<void, []>;
  /** Start the upload. Accepts an external signal for cascade abort (e.g. page navigation). */
  upload$: Command<Promise<void>, [AbortSignal]>;
}

function createChatAttachment(file: File): ZeroChatAttachment {
  const resetSignal$ = resetSignal();
  const internalPromise$ = state<Promise<FileInfo> | null>(null);

  const fileInfo$ = computed(async (get) => {
    const promise = get(internalPromise$);
    if (promise === null) {
      return null;
    }
    return await promise;
  });

  const cancel$ = command(({ set }) => {
    set(resetSignal$);
  });

  const upload$ = command(async ({ get, set }, signal: AbortSignal) => {
    const fetchFn = get(fetch$);
    const formData = new FormData();
    formData.append("file", file);

    const uploadSignal = set(resetSignal$, signal);
    const deferred = createDeferredPromise<FileInfo>(uploadSignal);
    set(internalPromise$, deferred.promise);

    const res = await fetchFn("/api/zero/uploads", {
      method: "POST",
      body: formData,
      signal: uploadSignal,
    });
    signal.throwIfAborted();

    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        err?.error?.message ?? `Upload failed: ${res.statusText}`,
      );
    }

    const data = (await res.json()) as {
      id: string;
      filename: string;
      contentType: string;
      size: number;
      url: string;
    };

    deferred.resolve({ id: data.id, url: data.url });
  });

  return {
    filename: file.name,
    contentType: file.type,
    size: file.size,
    fileInfo$,
    cancel$,
    upload$,
  };
}

const internalAttachments$ = state<ZeroChatAttachment[]>([]);
export const zeroChatAttachments$ = computed((get) =>
  get(internalAttachments$),
);

const internalDragOver$ = state(false);
export const zeroDragOver$ = computed((get) => get(internalDragOver$));
export const setZeroDragOver$ = command(({ set }, value: boolean) => {
  set(internalDragOver$, value);
});

export const uploadZeroAttachment$ = command(
  async ({ set }, file: File, signal: AbortSignal) => {
    const attachment = createChatAttachment(file);
    set(internalAttachments$, (prev) => [...prev, attachment]);

    try {
      await set(attachment.upload$, signal);
    } catch (error) {
      throwIfAbort(error);
      L.error("Upload failed:", error);
      set(attachment.cancel$);
      set(internalAttachments$, (prev) => prev.filter((a) => a !== attachment));
    }
  },
);

export const removeZeroAttachment$ = command(
  ({ set }, attachment: ZeroChatAttachment) => {
    set(attachment.cancel$);
    set(internalAttachments$, (prev) => prev.filter((a) => a !== attachment));
  },
);

/**
 * Load session data from the snapshot computed and populate state.
 * The snapshot auto-fetches when URL changes — this command reads the result,
 * populates server messages, syncs agent, and resumes polling if needed.
 */
export const loadSessionFromSnapshot$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const snapshot = await get(chatSessionSnapshot$);
    signal.throwIfAborted();
    if (!snapshot) {
      return;
    }

    // Resume polling for active runs: copy active run messages to local
    // and start their polling loops via beginLoop$.
    if (snapshot.activeRunMessages.length > 0) {
      set(internalLocalMessages$, snapshot.activeRunMessages);

      const assistantMessages = snapshot.activeRunMessages.filter(
        (m): m is AssistantChatMessage =>
          m.role === "assistant" && !!m.beginLoop$,
      );

      await Promise.all(
        assistantMessages.map(async (message) => {
          await set(message.beginLoop$!, signal);
        }),
      );
      signal.throwIfAborted();

      // Finalize each completed run (persist session ID, refresh sidebar)
      await Promise.all(
        assistantMessages
          .filter((m) => m.legacyRunId)
          .map(() => set(finalizeCompletedRun$, signal)),
      );
    }
  },
);

/**
 * Switch to a different chat session. Resets interaction state and navigates.
 * Session data loading is handled by `chatSessionSnapshot$` (async computed)
 * which auto-fetches when the URL changes.
 */
export const switchZeroSession$ = command(({ set }, threadId: string) => {
  set(navigateToChat$, threadId);
  set(internalLocalMessages$, []);
});

export const startNewZeroSession$ = command(({ set }) => {
  // Abort any in-flight send/polling from the previous session
  set(resetTalkSendSignal$);

  set(internalLocalMessages$, []);

  set(internalChatInput$, "");
});

// ---------------------------------------------------------------------------
// Commands: create new chat session (from sidebar "New chat" button)
// ---------------------------------------------------------------------------

const internalCreatingPromise$ = state<Promise<void> | undefined>(undefined);

export const creatingNewSession$ = computed(async (get) => {
  await get(internalCreatingPromise$);
});

const internalCreateNewChatSession$ = command(
  async ({ get, set }, agentComposeId: string | null, _signal: AbortSignal) => {
    try {
      set(startNewZeroSession$);

      const resolvedComposeId =
        agentComposeId ?? (await get(zeroOnboardingStatus$)).defaultAgentId;
      if (!resolvedComposeId) {
        toast.error("No agent available for new chat session");
        return;
      }

      const createClient = get(zeroClient$);
      const thread = await createChatThread(createClient, resolvedComposeId);

      set(reloadChatThreadList$, (n) => n + 1);
      set(navigateToChat$, thread.id);
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to create new chat session:", error);
      toast.error("Failed to create new chat session");
    }
  },
);

export const createNewChatSession$ = command(
  ({ set }, agentComposeId: string | null, signal: AbortSignal) => {
    const promise = set(internalCreateNewChatSession$, agentComposeId, signal);
    set(internalCreatingPromise$, promise);
    return promise;
  },
);

// ---------------------------------------------------------------------------
// Commands: send message
// ---------------------------------------------------------------------------

const prepareUserMessage$ = command(
  async (
    { get, set },
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ fullPrompt: string }> => {
    const allAttachments = get(internalAttachments$);
    const allInfos = await Promise.all(
      allAttachments.map((a) => get(a.fileInfo$)),
    );
    signal.throwIfAborted();

    // Pair attachments with resolved file info, dropping any that failed or haven't started
    const ready = allAttachments
      .map((a, i) => ({ attachment: a, info: allInfos[i] }))
      .filter(
        (r): r is { attachment: ZeroChatAttachment; info: FileInfo } =>
          r.info !== null,
      );

    let fullPrompt = prompt.trim();
    if (ready.length > 0) {
      const lines = ready.map(
        (r) =>
          `[Attached file: ${r.attachment.filename}](${r.info.url})\nDownload with: curl -sL -o "${r.attachment.filename}" "${r.info.url}"`,
      );
      fullPrompt = `${fullPrompt}\n\n${lines.join("\n")}`;
    }

    const userMessage: UserChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt.trim(),
      attachments:
        ready.length > 0
          ? ready.map((r) => ({
              filename: r.attachment.filename,
              contentType: r.attachment.contentType,
              size: r.attachment.size,
              url: r.info.url,
            }))
          : undefined,
    };
    set(internalLocalMessages$, (prev) => [...prev, userMessage]);
    set(internalAttachments$, []);

    return { fullPrompt };
  },
);

/** Post-polling cleanup: refresh sidebar and current thread. Session is managed server-side via callback. */
const finalizeCompletedRun$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Refresh session list (messages are persisted server-side via webhook)
    set(reloadChatThreadList$, (n) => n + 1);
    await delay(get(poolInterval$), { signal });
    set(reloadChatThreadList$, (n) => n + 1);
    // Invalidate the current thread so latestSessionId and messages are fresh
    set(reloadCurrentThread$, (n) => n + 1);
  },
);

/**
 * Create a run, associate it with a thread, poll until terminal, and handle completion.
 * Uses the unified POST /api/zero/chat/messages endpoint — a single HTTP call
 * replaces the previous 3-call orchestration (create thread + create run + add run to thread).
 */
const submitAndPollRun$ = command(
  async (
    { get, set },
    args: {
      composeId: string;
      prompt: string;
      fullPrompt: string;
      modelProvider?: string;
    },
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const existingThreadId = get(chatThreadId$);

    const modelProvider =
      args.modelProvider && args.modelProvider !== "default"
        ? args.modelProvider
        : undefined;

    // Single API call: create thread (if needed) + run + association
    const client = createClient(chatMessagesContract);
    const result = await client.send({
      body: {
        agentId: args.composeId,
        prompt: args.fullPrompt,
        ...(existingThreadId ? { threadId: existingThreadId } : {}),
        ...(modelProvider ? { modelProvider } : {}),
      },
    });
    signal.throwIfAborted();

    if (result.status !== 201) {
      if (
        result.status === 400 ||
        result.status === 403 ||
        result.status === 404
      ) {
        const code = result.body.error.code;
        const guidance = code ? RUN_ERROR_GUIDANCE[code] : undefined;
        const message = guidance
          ? `${guidance.title}: ${guidance.guidance}`
          : result.body.error.message;
        throw new Error(message);
      }
      throw new Error(`Failed to send message (${result.status})`);
    }

    const { runId, threadId } = result.body;

    // For new threads, navigate after server state is ready. The snapshot
    // reconstructs messages from unsavedRuns and resumes polling.
    if (!existingThreadId) {
      set(navigateToChat$, threadId);
      set(reloadChatThreadList$, (n) => n + 1);
      return;
    }

    // Refresh sidebar after run is associated (has preview now)
    set(reloadChatThreadList$, (n) => n + 1);

    // Create reactive assistant message with its own runLoop
    const { assistantMessage } = createActiveRunMessage(runId, args.prompt);
    set(internalLocalMessages$, (prev) => [...prev, assistantMessage]);

    const runLoop = assistantMessage.runLoop;
    if (!runLoop) {
      return;
    }

    await set(runLoop.beginLoop$, signal);

    await set(finalizeCompletedRun$, signal);
  },
);

export const sendZeroChatMessage$ = command(
  async (
    { get, set },
    prompt: string,
    options: { modelProvider?: string } | undefined,
    signal: AbortSignal,
  ) => {
    // Derive effective agent: URL agent (talk page), thread agent (chat page), or default
    const pathAgentId = get(currentAgentId$);
    const thread = pathAgentId === null ? await get(currentChatThread$) : null;
    const composeId =
      pathAgentId ?? thread?.agentId ?? (await get(defaultAgentId$));
    signal.throwIfAborted();
    if (!composeId || !prompt.trim()) {
      return;
    }

    const { fullPrompt } = await set(prepareUserMessage$, prompt, signal);
    signal.throwIfAborted();

    try {
      await set(
        submitAndPollRun$,
        {
          composeId,
          prompt,
          fullPrompt,
          modelProvider: options?.modelProvider,
        },
        signal,
      );
    } catch (error) {
      throwIfAbort(error);
      L.error("Chat send error:", error);
      // Clear the optimistic user message since the send failed.
      // The user stays on /talk/ with their input preserved for retry.
      set(internalLocalMessages$, []);
    }
  },
);

// ---------------------------------------------------------------------------
// Composite shell commands
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Composer local UI state
// ---------------------------------------------------------------------------

const internalComposerFileInput$ = state<HTMLElement | null>(null);

/** The file input element used by the composer attach button. */
export const composerFileInput$ = computed((get) =>
  get(internalComposerFileInput$),
);

/** Store a reference to the composer file input element. */
export const setComposerFileInput$ = command(
  ({ set }, el: HTMLElement | null) => {
    set(internalComposerFileInput$, el);
  },
);

const internalComposerAddDialogOpen$ = state(false);

/** Whether the "Add connector" dialog in the composer is open. */
export const composerAddDialogOpen$ = computed((get) =>
  get(internalComposerAddDialogOpen$),
);

/** Toggle the "Add connector" dialog open state. */
export const setComposerAddDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalComposerAddDialogOpen$, open);
});
