import { command, computed, state, type Computed } from "ccstate";
import type { AgentEvent, LogStatus } from "./log-types.ts";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort, detach, Reason } from "../utils.ts";
import { logger } from "../log.ts";
import { setupPollingLoop$, type PageResult } from "./polling.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import {
  navigateToZeroSession$,
  zeroChatAgentId$,
  setZeroChatAgent$,
  zeroInChat$,
} from "./zero-nav.ts";
import { agentsList$ } from "./agents-list.ts";
import type { ChatThreadListItem } from "@vm0/core";

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
  pages: Computed<Promise<PageResult>>[],
  get: (c: Computed<Promise<PageResult>>) => Promise<PageResult>,
): Promise<string> {
  let result = "";
  for (const page$ of pages) {
    const page = await get(page$);
    for (const event of page.events) {
      if (event.eventType === "result" && isResultEventData(event.eventData)) {
        result = event.eventData.result;
      }
    }
  }
  return result;
}

/** Fetch queue position for a run. Returns 0 if not queued. */
async function fetchQueuePosition(
  fetchFn: typeof fetch,
  runId: string,
): Promise<number> {
  const resp = await fetchFn(
    `/api/platform/queue-position?runId=${encodeURIComponent(runId)}`,
  );
  if (!resp.ok) {
    return 0;
  }
  const data = (await resp.json()) as { position: number };
  return data.position;
}

function updateQueuePosition(
  status: string,
  fetchFn: typeof fetch,
  runId: string,
  setPosition: (pos: number) => void,
) {
  if (status === "queued" || status === "pending") {
    fetchQueuePosition(fetchFn, runId)
      .then((pos) => setPosition(pos))
      .catch(() => {});
  } else {
    setPosition(0);
  }
}

/** Start an agent run and return the runId, or null on failure. */
async function startAgentRun(
  fetchFn: typeof fetch,
  composeId: string,
  prompt: string,
  sessionId?: string | null,
  modelProvider?: string | null,
): Promise<string | null> {
  const body: Record<string, string> = {
    agentComposeId: composeId,
    prompt: prompt.trim(),
  };
  if (sessionId) {
    body.sessionId = sessionId;
  }
  if (modelProvider) {
    body.modelProvider = modelProvider;
  }

  const response = await fetchFn("/api/agent/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { runId: string };
  return data.runId;
}

async function createChatThread(
  fetchFn: typeof fetch,
  agentComposeId: string,
  title?: string,
): Promise<string | null> {
  const response = await fetchFn("/api/chat-threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentComposeId, title }),
  });
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as { id: string };
  return data.id;
}

async function addRunToThread(
  fetchFn: typeof fetch,
  threadId: string,
  runId: string,
): Promise<void> {
  const response = await fetchFn(`/api/chat-threads/${threadId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId }),
  });
  if (!response.ok) {
    throw new Error(`Failed to associate run with thread: ${response.status}`);
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
  attachments?: ZeroChatMessageAttachment[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalMessages$ = state<ZeroChatMessage[]>([]);
export const zeroChatMessages$ = computed((get) => get(internalMessages$));

const internalSessionId$ = state<string | null>(null);
export const zeroCurrentSessionId$ = computed((get) => get(internalSessionId$));

const internalActiveRunId$ = state<string | null>(null);
const internalRunStatus$ = state<LogStatus | null>(null);
const internalRunError$ = state<string | null>(null);
const internalRunEvents$ = state<Computed<Promise<PageResult>>[]>([]);

const internalSending$ = state(false);
export const zeroChatSending$ = computed((get) => get(internalSending$));

/** Current run status (queued, pending, running, etc.) */
export const zeroChatRunStatus$ = computed((get) => get(internalRunStatus$));

/** Queue position for the active run (0 = not queued). */
const internalQueuePosition$ = state(0);
export const zeroChatQueuePosition$ = computed((get) =>
  get(internalQueuePosition$),
);

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

const TOOL_LABELS: Readonly<
  Record<string, (input: Record<string, unknown> | undefined) => string>
> = {
  Bash: (i) =>
    i?.command
      ? `Running: ${truncate(String(i.command), 60)}`
      : "Running a command",
  Read: (i) =>
    i?.file_path
      ? `Reading ${basename(String(i.file_path))}`
      : "Reading a file",
  Write: (i) =>
    i?.file_path
      ? `Writing ${basename(String(i.file_path))}`
      : "Writing a file",
  Edit: (i) =>
    i?.file_path
      ? `Editing ${basename(String(i.file_path))}`
      : "Editing a file",
  Grep: (i) =>
    i?.pattern
      ? `Searching for "${truncate(String(i.pattern), 40)}"`
      : "Searching code",
  Glob: (i) =>
    i?.pattern
      ? `Finding files: ${truncate(String(i.pattern), 40)}`
      : "Finding files",
  Skill: (i) => (i?.skill ? `Using ${String(i.skill)}` : "Using a skill"),
  WebSearch: (i) =>
    i?.query
      ? `Searching: ${truncate(String(i.query), 50)}`
      : "Searching the web",
  WebFetch: (i) =>
    i?.url ? `Fetching: ${truncate(String(i.url), 50)}` : "Fetching a page",
  Agent: () => "Working on a subtask",
};

function humanizeToolUse(
  name: string,
  input: Record<string, unknown> | undefined,
): string {
  const fn = TOOL_LABELS[name];
  if (fn) {
    return fn(input);
  }
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
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

const pollingAbortController$ = state<AbortController | null>(null);

/** Resume polling for an active run (used when switching to a session with an in-progress run). */
function resumeRunPolling(
  get: Parameters<Parameters<typeof command>[0]>[0]["get"],
  set: Parameters<Parameters<typeof command>[0]>[0]["set"],
  fetchFn: typeof fetch,
  runId: string,
) {
  set(internalActiveRunId$, runId);
  set(internalSending$, true);

  const controller = new AbortController();
  set(pollingAbortController$, controller);

  set(setupPollingLoop$, {
    runId,
    signal: controller.signal,
    state: {
      get events$() {
        return get(internalRunEvents$);
      },
      setEvents: (updater) => {
        set(internalRunEvents$, updater);
      },
      setStatus: (s) => {
        set(internalRunStatus$, s);
        updateQueuePosition(s, fetchFn, runId, (pos) =>
          set(internalQueuePosition$, pos),
        );
      },
      setError: (e) => {
        set(internalRunError$, e);
      },
    },
    onTerminal: (completedRunId) => {
      set(onZeroRunComplete$, completedRunId).catch((error: unknown) => {
        throwIfAbort(error);
        L.error("onRunComplete error:", error);
      });
    },
  }).catch((error: unknown) => {
    throwIfAbort(error);
  });
}

// Chat thread ID (for URL routing — set before run starts)
const internalChatThreadId$ = state<string | null>(null);
export const zeroChatThreadId$ = computed((get) => get(internalChatThreadId$));

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

const internalSessionError$ = state<string | null>(null);
export const zeroSessionError$ = computed((get) => get(internalSessionError$));

const internalSessionSwitching$ = state(false);
export const zeroSessionSwitching$ = computed((get) =>
  get(internalSessionSwitching$),
);

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

export const uploadZeroAttachment$ = command(
  async ({ get, set }, file: File) => {
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

    try {
      const fetchFn = get(fetch$);
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetchFn("/api/agent/uploads", {
        method: "POST",
        body: formData,
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
    }
  },
);

export const removeZeroAttachment$ = command(({ set }, id: string) => {
  set(internalAttachments$, (prev) => prev.filter((a) => a.id !== id));
});

// ---------------------------------------------------------------------------
// Commands: session list management
// ---------------------------------------------------------------------------

export const fetchZeroSessionList$ = command(async ({ get, set }) => {
  // Keep previous list visible while loading (no flash to empty).
  set(internalSessionListLoading$, true);
  set(internalSessionListError$, null);

  // Read the selected agent from localStorage; fall back to default agent
  const chatAgentId = get(zeroChatAgentId$);
  const composeId =
    chatAgentId ?? (await get(zeroOnboardingStatus$)).defaultAgentComposeId;
  if (!composeId) {
    set(internalSessionListLoading$, false);
    return;
  }
  try {
    const fetchFn = get(fetch$);
    const res = await fetchFn(
      `/api/chat-threads?agentComposeId=${encodeURIComponent(composeId)}`,
    );
    if (!res.ok) {
      set(internalSessionListError$, `Failed to load chats: ${res.statusText}`);
      return;
    }
    const data = (await res.json()) as { threads: ChatThreadListItem[] };
    set(internalSessionList$, data.threads);
  } catch (error) {
    throwIfAbort(error);
    const msg = error instanceof Error ? error.message : "Failed to load chats";
    set(internalSessionListError$, msg);
    L.error("Failed to fetch chat thread list:", error);
  } finally {
    set(internalSessionListLoading$, false);
  }
});

/**
 * Single entry point for changing the active agent.
 * Sets the agent identity AND refreshes the session list atomically.
 * All callers that need to change the active agent should use this.
 */
export const switchActiveAgent$ = command(
  ({ set }, agent: { id: string; name: string } | null) => {
    set(setZeroChatAgent$, agent);
    detach(set(fetchZeroSessionList$), Reason.DomCallback);
  },
);

/** Resolve which agent to activate based on the thread's agentComposeId. */
async function syncAgentForThread(
  get: Parameters<Parameters<typeof command>[0]>[0]["get"],
  set: Parameters<Parameters<typeof command>[0]>[0]["set"],
  agentComposeId: string | undefined,
) {
  if (agentComposeId) {
    const currentAgentId = get(zeroChatAgentId$);
    const status = await get(zeroOnboardingStatus$);
    const isDefault = agentComposeId === status.defaultAgentComposeId;
    const newAgentId = isDefault ? null : agentComposeId;
    if (newAgentId !== currentAgentId) {
      const agentName =
        newAgentId && get(agentsList$).find((a) => a.id === newAgentId)?.name;
      set(
        switchActiveAgent$,
        newAgentId ? { id: newAgentId, name: agentName ?? "" } : null,
      );
    } else if (get(internalSessionList$).length === 0) {
      detach(set(fetchZeroSessionList$), Reason.DomCallback);
    }
  } else if (get(zeroChatAgentId$) !== null) {
    set(switchActiveAgent$, null);
  } else if (get(internalSessionList$).length === 0) {
    detach(set(fetchZeroSessionList$), Reason.DomCallback);
  }
}

export const switchZeroSession$ = command(
  async ({ get, set }, threadId: string) => {
    // Abort any in-flight polling from the previous session
    const prev = get(pollingAbortController$);
    if (prev) {
      prev.abort();
    }
    set(pollingAbortController$, null);

    // Set thread immediately so the UI switches without loading delay
    set(internalChatThreadId$, threadId);
    set(internalSessionId$, null);
    set(internalMessages$, []);
    set(internalActiveRunId$, null);
    set(internalRunEvents$, []);
    set(internalRunStatus$, null);
    set(internalRunError$, null);
    set(internalQueuePosition$, 0);
    set(internalSending$, false);
    set(internalSessionError$, null);
    set(internalSessionSwitching$, true);

    try {
      const fetchFn = get(fetch$);

      // Try chat-threads API first; fall back to legacy sessions API
      L.info("loading thread:", threadId);
      let res = await fetchFn(`/api/chat-threads/${threadId}`);
      let isLegacySession = false;
      if (!res.ok) {
        res = await fetchFn(`/api/agent/sessions/${threadId}`);
        isLegacySession = true;
      }
      if (!res.ok) {
        L.warn("both APIs failed, status:", res.status);
        set(internalSessionError$, `Failed to load chat: ${res.statusText}`);
        return;
      }
      const data = (await res.json()) as {
        agentComposeId?: string;
        chatMessages?: {
          role: "user" | "assistant";
          content: string;
          runId?: string;
          createdAt: string;
        }[];
        latestSessionId?: string | null;
        unsavedRuns?: {
          runId: string;
          status: string;
          prompt: string;
          error: string | null;
        }[];
      };

      L.info("loaded:", {
        isLegacySession,
        agentComposeId: data.agentComposeId,
        latestSessionId: data.latestSessionId,
        msgCount: data.chatMessages?.length,
      });

      if (isLegacySession) {
        // Legacy session: the ID itself is the sessionId
        set(internalSessionId$, threadId);
      } else if (data.latestSessionId) {
        set(internalSessionId$, data.latestSessionId);
      }

      // Switch agent if it changed, or fetch session list if empty (fresh load).
      await syncAgentForThread(get, set, data.agentComposeId);

      const messages: ZeroChatMessage[] = (data.chatMessages ?? []).map(
        (m) => ({
          id: crypto.randomUUID(),
          role: m.role,
          content: m.content,
          runId: m.runId,
        }),
      );

      // Append unsaved runs (active, failed, pending) not yet in chatMessages.
      // These are in chronological order from the server.
      let activeRunToResume: string | null = null;
      for (const run of data.unsavedRuns ?? []) {
        messages.push({
          id: crypto.randomUUID(),
          role: "user",
          content: run.prompt,
        });

        const isFailed =
          run.status === "failed" ||
          run.status === "timeout" ||
          run.status === "cancelled";
        if (isFailed) {
          messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            runId: run.runId,
            status: "failed",
            error: "Something went wrong. Check the activity logs for details.",
          });
        } else {
          // Active/pending/running — show placeholder for polling
          messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            runId: run.runId,
          });
          activeRunToResume = run.runId;
        }
      }

      set(internalMessages$, messages);

      // Resume polling for the latest active run
      if (activeRunToResume) {
        resumeRunPolling(get, set, fetchFn, activeRunToResume);
      }
    } catch (error) {
      throwIfAbort(error);
      const msg =
        error instanceof Error ? error.message : "Failed to load chat";
      set(internalSessionError$, msg);
      L.error("Failed to switch chat thread:", error);
    } finally {
      set(internalSessionSwitching$, false);
    }
  },
);

export const startNewZeroSession$ = command(({ get, set }) => {
  // Abort any in-flight polling from the previous session
  const prev = get(pollingAbortController$);
  if (prev) {
    prev.abort();
  }
  set(pollingAbortController$, null);

  set(internalMessages$, []);
  set(internalSessionId$, null);
  set(internalChatThreadId$, null);
  set(internalActiveRunId$, null);
  set(internalRunEvents$, []);
  set(internalRunStatus$, null);
  set(internalRunError$, null);
  set(internalSending$, false);
  set(internalChatInput$, "");
});

// ---------------------------------------------------------------------------
// Commands: send message
// ---------------------------------------------------------------------------

function prepareMessages(
  prompt: string,
  get: (s: typeof internalAttachments$) => ZeroChatAttachment[],
  set: (
    s: typeof internalMessages$ | typeof internalAttachments$,
    u:
      | ZeroChatMessage[]
      | ((prev: ZeroChatMessage[]) => ZeroChatMessage[])
      | ZeroChatAttachment[],
  ) => void,
): { fullPrompt: string } {
  const attachments = (
    get(internalAttachments$) as ZeroChatAttachment[]
  ).filter((a) => !a.uploading);
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
  set(internalMessages$, (prev: ZeroChatMessage[]) => [...prev, userMessage]);
  set(internalAttachments$, []);

  const placeholder: ZeroChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
  };
  set(internalMessages$, (prev: ZeroChatMessage[]) => [...prev, placeholder]);

  return { fullPrompt };
}

export const sendZeroChatMessage$ = command(
  async (
    { get, set },
    prompt: string,
    options?: { modelProvider?: string },
  ) => {
    const chatAgentId = get(zeroChatAgentId$);
    const composeId =
      chatAgentId ?? (await get(zeroOnboardingStatus$)).defaultAgentComposeId;
    if (!composeId || !prompt.trim()) {
      return;
    }

    set(internalSending$, true);
    set(internalRunEvents$, []);
    set(internalRunStatus$, null);
    set(internalRunError$, null);
    set(internalQueuePosition$, 0);

    const { fullPrompt } = prepareMessages(prompt, get, set);

    try {
      const fetchFn = get(fetch$);
      const sessionId = get(internalSessionId$);
      let threadId = get(internalChatThreadId$);

      // Create a chat thread if this is a new conversation
      if (!threadId) {
        const title = prompt.trim().slice(0, 100);
        threadId = await createChatThread(fetchFn, composeId, title);
        if (!threadId) {
          set(internalMessages$, (prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              error: "Failed to create chat thread",
            };
            return updated;
          });
          set(internalSending$, false);
          return;
        }
        set(internalChatThreadId$, threadId);
        // Navigate immediately so URL updates
        if (get(zeroInChat$)) {
          set(navigateToZeroSession$, threadId);
        }
      }

      const modelProvider =
        options?.modelProvider && options.modelProvider !== "default"
          ? options.modelProvider
          : undefined;
      const runId = await startAgentRun(
        fetchFn,
        composeId,
        fullPrompt,
        sessionId,
        modelProvider,
      );

      if (!runId) {
        set(internalMessages$, (prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            error: "Failed to start agent run",
          };
          return updated;
        });
        set(internalSending$, false);
        return;
      }

      // Associate run to thread (must complete before polling so refresh works)
      await addRunToThread(fetchFn, threadId, runId);

      // Refresh sidebar after run is associated (has preview now)
      set(fetchZeroSessionList$).catch((error: unknown) => {
        throwIfAbort(error);
        L.error("Failed to refresh chat list:", error);
      });

      set(internalMessages$, (prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          runId,
        };
        return updated;
      });

      set(internalActiveRunId$, runId);

      // Abort any existing polling
      const prev = get(pollingAbortController$);
      if (prev) {
        prev.abort();
      }
      const controller = new AbortController();
      set(pollingAbortController$, controller);

      await set(setupPollingLoop$, {
        runId,
        signal: controller.signal,
        state: {
          get events$() {
            return get(internalRunEvents$);
          },
          setEvents: (updater) => {
            set(internalRunEvents$, updater);
          },
          setStatus: (s) => {
            set(internalRunStatus$, s);
            updateQueuePosition(s, get(fetch$), runId, (pos) =>
              set(internalQueuePosition$, pos),
            );
          },
          setError: (e) => {
            set(internalRunError$, e);
          },
        },
        onTerminal: (completedRunId) => {
          set(onZeroRunComplete$, completedRunId).catch((error: unknown) => {
            throwIfAbort(error);
            L.error("onRunComplete error:", error);
          });
        },
      });
    } catch (error) {
      throwIfAbort(error);
      L.error("Chat send error:", error);
      set(internalMessages$, (prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          error: error instanceof Error ? error.message : "Unknown error",
        };
        return updated;
      });
    } finally {
      set(internalSending$, false);
    }
  },
);

// ---------------------------------------------------------------------------
// On run complete: extract session, update message
// ---------------------------------------------------------------------------

const onZeroRunComplete$ = command(async ({ get, set }, runId: string) => {
  const runStatus = get(internalRunStatus$);
  const runError = get(internalRunError$);
  const messages = get(internalMessages$);
  const isFailed = runStatus === "failed";

  const lastIdx = messages.length - 1;
  if (lastIdx >= 0 && messages[lastIdx].role === "assistant") {
    set(internalMessages$, (prev) => {
      const updated = [...prev];
      updated[lastIdx] = {
        ...updated[lastIdx],
        status: runStatus ?? undefined,
        error: isFailed ? (runError ?? "Run failed") : undefined,
        runId,
      };
      return updated;
    });
  }

  // If run failed, no need to extract result or persist
  if (isFailed) {
    set(internalActiveRunId$, null);
    return;
  }

  set(internalActiveRunId$, null);

  try {
    const fetchFn = get(fetch$);
    const res = await fetchFn(`/api/agent/runs/${runId}`);
    if (res.ok) {
      const data = (await res.json()) as {
        result?: { output?: string; agentSessionId?: string };
      };
      // Store sessionId for conversation continuity (used by next message)
      if (data.result?.agentSessionId) {
        set(internalSessionId$, data.result.agentSessionId);
      }
    }

    // Extract result content from telemetry events
    const pages = get(internalRunEvents$);
    const resultContent = await extractResultFromEvents(pages, get);

    if (resultContent) {
      set(internalMessages$, (prev) => {
        const idx = prev.findIndex(
          (m) => m.role === "assistant" && m.runId === runId,
        );
        if (idx === -1) {
          return prev;
        }
        const updated = [...prev];
        updated[idx] = { ...updated[idx], content: resultContent };
        return updated;
      });
    }

    // Refresh session list (messages are persisted server-side via webhook)
    set(fetchZeroSessionList$).catch((error: unknown) => {
      throwIfAbort(error);
      L.error("Failed to refresh session list:", error);
    });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to extract run result:", error);
  }
});
