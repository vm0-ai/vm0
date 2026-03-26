import { command, computed, state, type Computed } from "ccstate";
import { timeout } from "signal-timers";
import type { AgentEvent, LogStatus } from "./log-types.ts";
import { fetch$ } from "../fetch.ts";
import {
  throwIfAbort,
  isAbortError,
  resetSignal,
  detach,
  Reason,
} from "../utils.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { logger } from "../log.ts";
import { setupPollingLoop$, type PagedRunEvents } from "./polling.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import {
  navigateToZeroSession$,
  zeroChatAgentId$,
  setZeroChatAgent$,
  zeroSessionId$,
} from "./zero-nav.ts";
import {
  RUN_ERROR_GUIDANCE,
  zeroRunsCancelContract,
  zeroRunsMainContract,
  zeroRunsByIdContract,
  zeroQueuePositionContract,
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadRunsContract,
  zeroSessionsByIdContract,
  type ChatThreadListItem,
  type SummaryEntry,
} from "@vm0/core";
import { zeroClient$, type ZeroClientFactory } from "../api-client.ts";

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
async function extractResultFromEvents(
  pages: Computed<Promise<PagedRunEvents>>[],
  get: (c: Computed<Promise<PagedRunEvents>>) => Promise<PagedRunEvents>,
): Promise<{ result: string; summaries: string[] }> {
  let result = "";
  const allEvents: AgentEvent[] = [];
  for (const page$ of pages) {
    const page = await get(page$);
    for (const event of page.events) {
      allEvents.push(event);
      if (event.eventType === "result" && isResultEventData(event.eventData)) {
        result = event.eventData.result;
      }
    }
  }
  let lastTextIdx = -1;
  for (let i = allEvents.length - 1; i >= 0; i--) {
    if (hasTextBlock(allEvents[i])) {
      lastTextIdx = i;
      break;
    }
  }
  const summaries: string[] = [];
  for (let i = 0; i < allEvents.length; i++) {
    const s = summarizeEvent(allEvents[i], i === lastTextIdx);
    if (s) {
      summaries.push(s);
    }
  }
  return { result, summaries };
}

/** Fetch queue position for a run. Returns 0 if not queued. */
async function fetchQueuePosition(
  createClient: ZeroClientFactory,
  runId: string,
): Promise<number> {
  const client = createClient(zeroQueuePositionContract);
  const result = await client.getPosition({ query: { runId } });
  if (result.status !== 200) {
    return 0;
  }
  return result.body.position;
}

function updateQueuePosition(
  status: string,
  createClient: ZeroClientFactory,
  runId: string,
  setPosition: (pos: number) => void,
) {
  if (status === "queued") {
    fetchQueuePosition(createClient, runId)
      .then((pos) => setPosition(pos))
      .catch(() => {});
  } else {
    setPosition(0);
  }
}

/** Start an agent run and return the runId. Throws on failure with the API error message. */
async function startAgentRun(
  createClient: ZeroClientFactory,
  composeId: string,
  prompt: string,
  sessionId?: string | null,
  modelProvider?: string | null,
): Promise<string> {
  const client = createClient(zeroRunsMainContract);
  const result = await client.create({
    body: {
      prompt: prompt.trim(),
      agentId: composeId,
      ...(sessionId ? { sessionId } : {}),
      ...(modelProvider ? { modelProvider } : {}),
    },
  });
  if (result.status === 201) {
    return result.body.runId;
  }
  if (result.status === 400 || result.status === 403 || result.status === 404) {
    const code = result.body.error.code;
    const guidance = code ? RUN_ERROR_GUIDANCE[code] : undefined;
    const message = guidance
      ? `${guidance.title}: ${guidance.guidance}`
      : result.body.error.message;
    throw new Error(message);
  }
  throw new Error(`Failed to start agent run (${result.status})`);
}

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

async function addRunToThread(
  createClient: ZeroClientFactory,
  threadId: string,
  runId: string,
): Promise<void> {
  const client = createClient(chatThreadRunsContract);
  const result = await client.addRun({
    params: { id: threadId },
    body: { runId },
  });
  if (result.status !== 204) {
    throw new Error(`Failed to associate run with thread (${result.status})`);
  }
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

export interface ZeroChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId?: string;
  status?: LogStatus;
  error?: string;
  cancelled?: boolean;
  attachments?: ZeroChatMessageAttachment[];
  summaries?: string[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Local interaction messages — user sends + assistant placeholders updated by polling.
 * These are appended during the current send cycle and cleared on session switch.
 */
const internalLocalMessages$ = state<ZeroChatMessage[]>([]);

/**
 * All chat messages: server snapshot (from URL) + local interaction overlay.
 * Async because server messages come from `chatSessionSnapshot$`.
 */
/**
 * All chat messages: server snapshot (completed) + local (active interaction).
 * Active run messages live in local state so polling can mutate them.
 * No dedup needed — snapshot.messages excludes active runs.
 */
export const zeroChatMessages$ = computed(async (get) => {
  const snapshot = await get(chatSessionSnapshot$);
  const serverMessages = snapshot?.messages ?? [];
  const localMessages = get(internalLocalMessages$);
  return [...serverMessages, ...localMessages];
});

const internalSessionId$ = state<string | null>(null);
export const zeroCurrentSessionId$ = computed((get) => get(internalSessionId$));

const internalActiveRunId$ = state<string | null>(null);
const internalRunStatus$ = state<LogStatus | null>(null);
const internalRunError$ = state<string | null>(null);
const internalRunEvents$ = state<Computed<Promise<PagedRunEvents>>[]>([]);

/** Whether the agent is currently busy (derived from loop promise). */
export const zeroChatSending$ = computed(
  (get) => get(internalLoopPromise$) !== null,
);

/** Current run status (queued, pending, running, etc.) */
export const zeroChatRunStatus$ = computed((get) => get(internalRunStatus$));

/** Cancel the currently active run. */
export const cancelActiveRun$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const runId = get(internalActiveRunId$);
    if (!runId) {
      return;
    }

    // Abort the send phase; the loop (on pageSignal) continues and discovers
    // the `cancelled` status on the next poll (~3s).
    set(resetSending$);

    const client = get(zeroClient$)(zeroRunsCancelContract);
    await client.cancel({ params: { id: runId } });
  },
);

/** Queue position for the active run (0 = not queued). */
const internalQueuePosition$ = state(0);
export const zeroChatQueuePosition$ = computed((get) =>
  get(internalQueuePosition$),
);

// ---------------------------------------------------------------------------
// Queued message — allows the user to queue a follow-up while agent is busy
// ---------------------------------------------------------------------------

interface QueuedMessage {
  text: string;
  modelProvider?: string;
}

const internalQueuedMessage$ = state<QueuedMessage | null>(null);
export const zeroChatQueuedMessage$ = computed((get) =>
  get(internalQueuedMessage$),
);

/** Queue a message to be sent automatically once the current run completes. */
export const queueZeroChatMessage$ = command(
  ({ get, set }, text: string, options?: { modelProvider?: string }) => {
    // Only queue when there's an active loop (agent is busy)
    if (!get(internalLoopPromise$)) {
      return;
    }
    if (get(internalQueuedMessage$)) {
      return;
    }
    set(internalQueuedMessage$, {
      text,
      modelProvider: options?.modelProvider,
    });
    set(internalChatInput$, "");
  },
);

/** Withdraw the queued message back into the input box for editing. */
export const withdrawQueuedMessage$ = command(({ get, set }) => {
  const queued = get(internalQueuedMessage$);
  if (!queued) {
    return;
  }
  set(internalChatInput$, queued.text);
  set(internalQueuedMessage$, null);
});

/** Latest event summaries for the active run (for display while thinking). */
export const zeroChatRunSummaries$ = computed(async (get) => {
  const pages = get(internalRunEvents$);
  if (pages.length === 0) {
    return [];
  }
  // Collect all events across pages
  const allEvents: AgentEvent[] = [];
  for (const page of pages) {
    const result = await get(page);
    allEvents.push(...result.events);
  }
  // Find the last text event index to exclude it (it's typically the result)
  let lastTextIdx = -1;
  for (let i = allEvents.length - 1; i >= 0; i--) {
    if (hasTextBlock(allEvents[i])) {
      lastTextIdx = i;
      break;
    }
  }
  const summaries: string[] = [];
  for (let i = 0; i < allEvents.length; i++) {
    const s = summarizeEvent(allEvents[i], i === lastTextIdx);
    if (s) {
      summaries.push(s);
    }
  }
  return summaries;
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

// ---------------------------------------------------------------------------
// Cancellation via resetSignal (replaces manual pollingAbortController$)
// ---------------------------------------------------------------------------

const resetSending$ = resetSignal();

/**
 * Signal for talk-page sends that must survive page navigation.
 *
 * The talk page navigates from `/talk/` to `/chat/:sessionId` on send,
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

const internalLoopPromise$ = state<Promise<void> | null>(null);

// ---------------------------------------------------------------------------
// Thinking messages (cycled during polling loop)
// ---------------------------------------------------------------------------

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

const internalThinkingIndex$ = state(
  Math.floor(Math.random() * THINKING_MESSAGES.length),
);

export const zeroChatThinkingMessage$ = computed(
  (get) => THINKING_MESSAGES[get(internalThinkingIndex$)]!,
);

/** Thread ID derived from the URL `/chat/:id`. */
export const zeroChatThreadId$ = zeroSessionId$;

// Session list state (now backed by chat threads)
const internalSessionList$ = state<ChatThreadListItem[]>([]);
export const zeroSessionList$ = computed((get) => get(internalSessionList$));

const internalSessionListLoading$ = state(false);
export const zeroSessionListLoading$ = computed((get) =>
  get(internalSessionListLoading$),
);

const internalSessionListError$ = state<string | null>(null);
export const zeroSessionListError$ = computed((get) =>
  get(internalSessionListError$),
);

// ---------------------------------------------------------------------------
// Session snapshot — async computed derived from URL
// ---------------------------------------------------------------------------

interface ChatSessionSnapshotData {
  /** Completed/failed messages — immutable, rendered directly from snapshot. */
  messages: ZeroChatMessage[];
  /** Active run prompt + placeholder — copied to local state for mutable polling updates. */
  activeRunMessages: ZeroChatMessage[];
  latestSessionId: string | null;
  agentComposeId?: string;
  activeRunId: string | null;
}

const snapshotVersion$ = state(0);

/**
 * Async computed that fetches session data whenever the URL thread ID changes.
 * Loading/error states are derived automatically via `useLoadable` in the view.
 * Eliminates the need for manual `internalSessionSwitching$` / `internalSessionError$`.
 */
export const chatSessionSnapshot$ = computed(
  async (get): Promise<ChatSessionSnapshotData | null> => {
    get(snapshotVersion$);
    const threadId = get(zeroSessionId$);
    if (!threadId) {
      return null;
    }

    let agentComposeId: string | undefined;
    let chatMessages: {
      role: "user" | "assistant";
      content: string;
      runId?: string;
      error?: string;
      summaries?: SummaryEntry[];
      createdAt: string;
    }[] = [];
    let latestSessionId: string | null = null;
    let unsavedRuns: {
      runId: string;
      status: string;
      prompt: string;
      error: string | null;
    }[] = [];
    let isLegacySession = false;

    const threadClient = get(zeroClient$)(chatThreadByIdContract);
    const threadResult = await threadClient.get({
      params: { id: threadId },
    });
    if (threadResult.status === 200) {
      const body = threadResult.body;
      agentComposeId = body.agentId;
      chatMessages = body.chatMessages ?? [];
      latestSessionId = body.latestSessionId ?? null;
      unsavedRuns = body.unsavedRuns ?? [];
    } else {
      const sessionClient = get(zeroClient$)(zeroSessionsByIdContract);
      const sessionResult = await sessionClient.getById({
        params: { id: threadId },
      });
      if (sessionResult.status !== 200) {
        L.warn("Failed to load chat");
        return null;
      }
      const body = sessionResult.body;
      agentComposeId = body.agentId;
      chatMessages = body.chatMessages ?? [];
      isLegacySession = true;
    }

    const resolvedSessionId = isLegacySession ? threadId : latestSessionId;

    const messages: ZeroChatMessage[] = chatMessages.map((m) => {
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
        runId: m.runId,
        ...(summaries && summaries.length > 0 ? { summaries } : {}),
        ...(m.error ? { status: "failed" as const, error: m.error } : {}),
      };
    });

    let activeRunId: string | null = null;
    const activeRunMessages: ZeroChatMessage[] = [];
    for (const run of unsavedRuns) {
      const userMsg: ZeroChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: run.prompt,
      };

      const isCancelled = run.status === "cancelled";
      const isFailed =
        run.status === "failed" || run.status === "timeout" || isCancelled;
      if (isFailed) {
        // Failed/cancelled runs are immutable — go to messages
        messages.push(userMsg);
        messages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          runId: run.runId,
          status: "failed",
          error: isCancelled
            ? "Run cancelled."
            : (run.error ??
              "Something went wrong. Check the activity logs for details."),
        });
      } else {
        // Active run — goes to activeRunMessages (will be copied to local state)
        activeRunMessages.push(userMsg);
        activeRunMessages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          runId: run.runId,
        });
        activeRunId = run.runId;
      }
    }

    return {
      messages,
      activeRunMessages,
      latestSessionId: resolvedSessionId,
      agentComposeId,
      activeRunId,
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
export interface ZeroChatAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  uploading?: boolean;
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

const uploadAbortControllers$ = state(new Map<string, AbortController>());

export const uploadZeroAttachment$ = command(
  async ({ get, set }, file: File, signal: AbortSignal) => {
    const id = crypto.randomUUID();
    const placeholder: ZeroChatAttachment = {
      id,
      filename: file.name,
      contentType: file.type,
      size: file.size,
      url: "",
      uploading: true,
    };
    set(internalAttachments$, (prev) => [...prev, placeholder]);

    const controller = new AbortController();
    set(uploadAbortControllers$, (prev) => new Map(prev).set(id, controller));

    try {
      const fetchFn = get(fetch$);
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetchFn("/api/zero/uploads", {
        method: "POST",
        body: formData,
        signal: AbortSignal.any([signal, controller.signal]),
      });

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

      set(internalAttachments$, (prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, url: data.url, id: data.id, uploading: false }
            : a,
        ),
      );
    } catch (error) {
      throwIfAbort(error);
      L.error("Upload failed:", error);
      // Remove the failed placeholder
      set(internalAttachments$, (prev) => prev.filter((a) => a.id !== id));
    } finally {
      // Clean up the controller entry. When cancel triggers this path, the
      // entry was already removed by cancelZeroAttachmentUpload$ — Map.delete
      // on a missing key is a safe no-op.
      set(uploadAbortControllers$, (prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  },
);

export const removeZeroAttachment$ = command(({ set }, id: string) => {
  set(internalAttachments$, (prev) => prev.filter((a) => a.id !== id));
});

export const cancelZeroAttachmentUpload$ = command(
  ({ get, set }, id: string) => {
    const controllers = get(uploadAbortControllers$);
    const controller = controllers.get(id);
    if (controller) {
      controller.abort();
      set(uploadAbortControllers$, (prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
    set(internalAttachments$, (prev) => prev.filter((a) => a.id !== id));
  },
);

// ---------------------------------------------------------------------------
// Commands: session list management
// ---------------------------------------------------------------------------

export const fetchZeroSessionList$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Keep previous list visible while loading (no flash to empty).
    set(internalSessionListLoading$, true);
    set(internalSessionListError$, null);

    // Read the selected agent from localStorage; fall back to default agent
    const chatAgentId = get(zeroChatAgentId$);
    const composeId =
      chatAgentId ?? (await get(zeroOnboardingStatus$)).defaultAgentId;
    if (!composeId) {
      set(internalSessionListLoading$, false);
      return;
    }
    try {
      const client = get(zeroClient$)(chatThreadsContract);
      const result = await client.list({ query: { agentId: composeId } });
      signal.throwIfAborted();
      if (result.status !== 200) {
        set(
          internalSessionListError$,
          `Failed to load chats (${result.status})`,
        );
        return;
      }
      set(internalSessionList$, result.body.threads);
    } catch (error) {
      throwIfAbort(error);
      const msg =
        error instanceof Error ? error.message : "Failed to load chats";
      set(internalSessionListError$, msg);
      L.error("Failed to fetch chat thread list:", error);
    } finally {
      set(internalSessionListLoading$, false);
    }
  },
);

/**
 * Single entry point for changing the active agent.
 * Sets the agent identity AND refreshes the session list atomically.
 * All callers that need to change the active agent should use this.
 */
export const switchActiveAgent$ = command(
  async ({ set }, agentId: string | null, signal: AbortSignal) => {
    set(setZeroChatAgent$, agentId);
    await set(fetchZeroSessionList$, signal);
  },
);

/** Resolve which agent to activate based on the thread's agentComposeId. */
const syncAgentForThread$ = command(
  async (
    { get, set },
    agentComposeId: string | undefined,
    signal: AbortSignal,
  ) => {
    if (agentComposeId) {
      const currentAgentId = get(zeroChatAgentId$);
      const status = await get(zeroOnboardingStatus$);
      signal.throwIfAborted();
      const isDefault = agentComposeId === status.defaultAgentId;
      const newAgentId = isDefault ? null : agentComposeId;
      if (newAgentId !== currentAgentId) {
        await set(switchActiveAgent$, newAgentId, signal);
      } else if (get(internalSessionList$).length === 0) {
        detach(set(fetchZeroSessionList$, signal), Reason.DomCallback);
      }
    } else if (get(zeroChatAgentId$) !== null) {
      await set(switchActiveAgent$, null, signal);
    } else if (get(internalSessionList$).length === 0) {
      detach(set(fetchZeroSessionList$, signal), Reason.DomCallback);
    }
  },
);

// ---------------------------------------------------------------------------
// startLoop$: independent polling entry point
// ---------------------------------------------------------------------------

/**
 * Start polling for a run. Sets `internalLoopPromise$` so `lastMessageProcessing$`
 * reflects the active loop. Can be called standalone (session resume) or from
 * `sendZeroChatMessage$` (send flow).
 *
 * The loop uses `signal` for cancellation — typically composed from
 * `resetSending$` + `pageSignal$` via `AbortSignal.any()`.
 */
const startLoop$ = command(
  async (
    { get, set },
    config: { runId: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const { runId } = config;
    const createClient = get(zeroClient$);

    set(internalActiveRunId$, runId);

    const loopPromise = (async () => {
      await set(
        setupPollingLoop$,
        {
          runId,
          state: {
            get events$() {
              return get(internalRunEvents$);
            },
            setEvents: (updater) => {
              set(internalRunEvents$, updater);
            },
            setStatus: (s) => {
              set(internalRunStatus$, s);
              updateQueuePosition(s, createClient, runId, (pos) =>
                set(internalQueuePosition$, pos),
              );
              // Cycle thinking message on each status update
              set(
                internalThinkingIndex$,
                (prev) => (prev + 1) % THINKING_MESSAGES.length,
              );
            },
            setError: (e) => {
              set(internalRunError$, e);
            },
          },
          onTerminal: (completedRunId) => {
            set(onZeroRunComplete$, completedRunId, signal).catch(
              (error: unknown) => {
                if (!isAbortError(error)) {
                  L.error("onRunComplete error:", error);
                }
              },
            );
          },
        },
        signal,
      );
    })();

    set(internalLoopPromise$, loopPromise);
    try {
      await loopPromise;
    } finally {
      // Only clear if this is still the active loop (not replaced by a newer one)
      if (get(internalLoopPromise$) === loopPromise) {
        set(internalLoopPromise$, null);
      }
    }
  },
);

/**
 * Load session data from the snapshot computed and populate state.
 * The snapshot auto-fetches when URL changes — this command reads the result,
 * populates server messages, syncs agent, and resumes polling if needed.
 */
export const loadSessionFromSnapshot$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Skip if local messages are in-flight (e.g., navigating from /talk
    // after sending a message — optimistic messages are already displayed).
    if (get(internalLocalMessages$).length > 0) {
      return;
    }

    const snapshot = await get(chatSessionSnapshot$);
    signal.throwIfAborted();
    if (!snapshot) {
      return;
    }

    if (snapshot.latestSessionId) {
      set(internalSessionId$, snapshot.latestSessionId);
    }

    await set(syncAgentForThread$, snapshot.agentComposeId, signal);
    signal.throwIfAborted();

    // Resume polling for active run: copy active run messages to local
    // so polling can mutate the assistant placeholder (snapshot is immutable).
    if (snapshot.activeRunId) {
      set(internalLocalMessages$, snapshot.activeRunMessages);
      const resumeSignal = set(resetSending$, signal);
      detach(
        set(startLoop$, { runId: snapshot.activeRunId }, resumeSignal),
        Reason.Daemon,
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
  set(resetSending$);
  set(navigateToZeroSession$, threadId);
  set(internalSessionId$, null);
  set(internalLocalMessages$, []);
  set(internalActiveRunId$, null);
  set(internalRunEvents$, []);
  set(internalRunStatus$, null);
  set(internalRunError$, null);
  set(internalQueuePosition$, 0);
  set(internalLoopPromise$, null);
});

export const startNewZeroSession$ = command(({ set }) => {
  // Abort any in-flight send/polling from the previous session
  set(resetSending$);
  set(resetTalkSendSignal$);

  set(internalLocalMessages$, []);
  set(internalSessionId$, null);
  set(internalActiveRunId$, null);
  set(internalRunEvents$, []);
  set(internalRunStatus$, null);
  set(internalRunError$, null);
  set(internalLoopPromise$, null);
  set(internalChatInput$, "");
});

// ---------------------------------------------------------------------------
// Commands: create new chat session (from sidebar "New chat" button)
// ---------------------------------------------------------------------------

const creatingNewSession$ = state(false);
export const zeroCreatingNewSession$ = computed((get) =>
  get(creatingNewSession$),
);

export const createNewChatSession$ = command(
  async ({ get, set }, agentComposeId: string | null, _signal: AbortSignal) => {
    set(creatingNewSession$, true);
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

      const now = new Date().toISOString();
      set(internalSessionList$, (prev) => [
        {
          id: thread.id,
          title: thread.title,
          preview: null,
          agentId: resolvedComposeId,
          createdAt: now,
          updatedAt: now,
        },
        ...prev,
      ]);

      set(navigateToZeroSession$, thread.id);
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to create new chat session:", error);
      toast.error("Failed to create new chat session");
    } finally {
      set(creatingNewSession$, false);
    }
  },
);

// ---------------------------------------------------------------------------
// Commands: send message
// ---------------------------------------------------------------------------

const prepareMessages$ = command(
  ({ get, set }, prompt: string): { fullPrompt: string } => {
    const attachments = get(internalAttachments$).filter((a) => !a.uploading);
    let fullPrompt = prompt.trim();
    if (attachments.length > 0) {
      const lines = attachments.map(
        (a) =>
          `[Attached file: ${a.filename}](${a.url})\nDownload with: curl -sL -o "${a.filename}" "${a.url}"`,
      );
      fullPrompt = `${fullPrompt}\n\n${lines.join("\n")}`;
    }

    const userMessage: ZeroChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt.trim(),
      attachments:
        attachments.length > 0
          ? attachments.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              size: a.size,
              url: a.url,
            }))
          : undefined,
    };
    set(internalLocalMessages$, (prev) => [...prev, userMessage]);
    set(internalAttachments$, []);

    const placeholder: ZeroChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
    };
    set(internalLocalMessages$, (prev) => [...prev, placeholder]);

    return { fullPrompt };
  },
);

/**
 * Ensure a chat thread exists for the current conversation.
 * Creates one if needed and updates sidebar + URL. Returns the thread ID,
 * or null if creation failed (caller should abort).
 */
const ensureChatThread$ = command(
  async (
    { get, set },
    args: { composeId: string; prompt: string },
    _signal: AbortSignal,
  ): Promise<string | null> => {
    const threadId = get(zeroSessionId$);
    if (threadId) {
      return threadId;
    }

    const createClient = get(zeroClient$);
    const title = args.prompt.trim().slice(0, 100);
    let thread: { id: string; title: string | null };
    try {
      thread = await createChatThread(createClient, args.composeId, title);
    } catch (error) {
      throwIfAbort(error);
      set(internalLocalMessages$, (prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          error: "Failed to create chat thread",
        };
        return updated;
      });
      return null;
    }

    // Add the new thread to the session list so the sidebar updates immediately
    const now = new Date().toISOString();
    set(internalSessionList$, (prev) => [
      {
        id: thread.id,
        title: thread.title ?? title,
        preview: null,
        agentId: args.composeId,
        createdAt: now,
        updatedAt: now,
      },
      ...prev,
    ]);
    // Navigate so zeroSessionId$ (URL) reflects the new thread
    set(navigateToZeroSession$, thread.id);

    return thread.id;
  },
);

export const sendZeroChatMessage$ = command(
  async (
    { get, set },
    prompt: string,
    options: { modelProvider?: string } | undefined,
    signal: AbortSignal,
  ) => {
    const chatAgentId = get(zeroChatAgentId$);
    const composeId =
      chatAgentId ?? (await get(zeroOnboardingStatus$)).defaultAgentId;
    if (!composeId || !prompt.trim()) {
      return;
    }

    const sendSignal = set(resetSending$);
    const combinedSignal = AbortSignal.any([signal, sendSignal]);
    let currentPrompt = prompt;
    let currentOptions = options;

    try {
      // While loop replaces recursive detach() for queued messages
      while (true) {
        set(internalRunEvents$, []);
        set(internalRunStatus$, null);
        set(internalRunError$, null);
        set(internalQueuePosition$, 0);

        const { fullPrompt } = set(prepareMessages$, currentPrompt);

        try {
          const createClient = get(zeroClient$);
          const sessionId = get(internalSessionId$);

          const threadId = await set(
            ensureChatThread$,
            {
              composeId,
              prompt: currentPrompt,
            },
            combinedSignal,
          );
          signal.throwIfAborted();
          if (!threadId) {
            return;
          }

          combinedSignal.throwIfAborted();

          const modelProvider =
            currentOptions?.modelProvider &&
            currentOptions.modelProvider !== "default"
              ? currentOptions.modelProvider
              : undefined;
          const runId = await startAgentRun(
            createClient,
            composeId,
            fullPrompt,
            sessionId,
            modelProvider,
          );
          signal.throwIfAborted();

          combinedSignal.throwIfAborted();

          // Associate run to thread (must complete before polling so refresh works)
          await addRunToThread(createClient, threadId, runId);
          signal.throwIfAborted();

          // Refresh sidebar after run is associated (has preview now)
          set(fetchZeroSessionList$, combinedSignal).catch((error: unknown) => {
            if (!isAbortError(error)) {
              L.error("Failed to refresh chat list:", error);
            }
          });

          set(internalLocalMessages$, (prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              runId,
            };
            return updated;
          });

          // Loop phase: poll until terminal
          await set(startLoop$, { runId }, combinedSignal);
        } catch (error) {
          throwIfAbort(error);
          L.error("Chat send error:", error);
          set(internalLocalMessages$, (prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              error: error instanceof Error ? error.message : "Unknown error",
            };
            return updated;
          });
          return;
        }

        // Check for pending (queued) message
        const pending = get(internalQueuedMessage$);
        if (!pending) {
          break;
        }
        currentPrompt = pending.text;
        currentOptions = pending.modelProvider
          ? { modelProvider: pending.modelProvider }
          : undefined;
        set(internalQueuedMessage$, null);
      }
    } finally {
      // Auto-withdraw pending message back to input on abort/error
      const pending = get(internalQueuedMessage$);
      if (pending) {
        set(internalChatInput$, pending.text);
        set(internalQueuedMessage$, null);
      }
    }
  },
);

// ---------------------------------------------------------------------------
// On run complete: extract session, update message
// ---------------------------------------------------------------------------

/** Update an assistant message by runId in local messages. */
const updateAssistantMessage$ = command(
  (
    { get, set },
    args: { runId: string; updater: (msg: ZeroChatMessage) => ZeroChatMessage },
  ) => {
    const local = get(internalLocalMessages$);
    const idx = local.findIndex(
      (m) => m.role === "assistant" && m.runId === args.runId,
    );
    if (idx === -1) {
      return;
    }
    set(internalLocalMessages$, (prev) => {
      const updated = [...prev];
      updated[idx] = args.updater(updated[idx]);
      return updated;
    });
  },
);

/** Update the last assistant message in local messages. */
const updateLastAssistantMessage$ = command(
  ({ get, set }, updater: (msg: ZeroChatMessage) => ZeroChatMessage) => {
    const local = get(internalLocalMessages$);
    const last = local.length - 1;
    if (last >= 0 && local[last].role === "assistant") {
      set(internalLocalMessages$, (prev) => {
        const updated = [...prev];
        updated[last] = updater(updated[last]);
        return updated;
      });
    }
  },
);

const onZeroRunComplete$ = command(
  async ({ get, set }, runId: string, signal: AbortSignal) => {
    const runStatus = get(internalRunStatus$);
    const runError = get(internalRunError$);
    const isFailed =
      runStatus === "failed" ||
      runStatus === "timeout" ||
      runStatus === "cancelled";

    set(updateLastAssistantMessage$, (msg) => ({
      ...msg,
      status: runStatus ?? undefined,
      error: isFailed
        ? (runError ??
          (runStatus === "timeout"
            ? "Run timed out"
            : runStatus === "cancelled"
              ? "Run cancelled."
              : "Run failed"))
        : undefined,
      runId,
    }));

    // If run failed/timeout/cancelled, no need to extract result or persist
    if (isFailed) {
      set(internalActiveRunId$, null);
      return;
    }

    set(internalActiveRunId$, null);

    // Capture events BEFORE any await — the queued-message auto-send in
    // sendZeroChatMessage$'s finally block may clear internalRunEvents$
    // while we're waiting on the network.
    const pages = get(internalRunEvents$);

    try {
      const client = get(zeroClient$)(zeroRunsByIdContract);
      const result = await client.getById({ params: { id: runId } });
      signal.throwIfAborted();
      if (result.status === 200) {
        // Store sessionId for conversation continuity (used by next message)
        if (result.body.result?.agentSessionId) {
          set(internalSessionId$, result.body.result.agentSessionId);
        }
      }

      // Extract result content and summaries from telemetry events
      const { result: resultContent, summaries } =
        await extractResultFromEvents(pages, get);
      signal.throwIfAborted();

      if (resultContent || summaries.length > 0) {
        set(updateAssistantMessage$, {
          runId,
          updater: (msg) => ({
            ...msg,
            ...(resultContent ? { content: resultContent } : {}),
            ...(summaries.length > 0 ? { summaries } : {}),
          }),
        });
      }

      // Refresh session list (messages are persisted server-side via webhook)
      set(fetchZeroSessionList$, signal).catch((error: unknown) => {
        if (!isAbortError(error)) {
          L.error("Failed to refresh session list:", error);
        }
      });

      // Refresh again after a short delay so the AI-generated title (produced by
      // the webhook's after() callback via OpenRouter) has time to land in the DB.
      // This is a best-effort poll — the title may arrive later if the API is slow,
      // in which case the user will see it on next navigation. A push-based approach
      // (e.g. Ably or Zero sync) would be more reliable but is out of scope here.
      timeout(() => {
        set(fetchZeroSessionList$, signal).catch((error: unknown) => {
          if (!isAbortError(error)) {
            L.error("Failed to refresh session list (delayed):", error);
          }
        });
      }, 1000);
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to extract run result:", error);
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
