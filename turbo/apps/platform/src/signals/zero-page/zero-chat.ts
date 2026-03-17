import { command, computed, state, type Computed } from "ccstate";
import type { AgentEvent, LogStatus } from "./log-types.ts";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { setupPollingLoop$, type PageResult } from "./polling.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import {
  navigateToZeroSession$,
  zeroChatAgentId$,
  zeroInChat$,
} from "./zero-nav.ts";
import type { SessionListItem } from "@vm0/core";

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

// Session list state
const internalSessionList$ = state<SessionListItem[]>([]);
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
  // Clear stale data immediately (before any await)
  set(internalSessionList$, []);
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
      `/api/agent/sessions?agentComposeId=${encodeURIComponent(composeId)}`,
    );
    if (!res.ok) {
      set(
        internalSessionListError$,
        `Failed to load sessions: ${res.statusText}`,
      );
      return;
    }
    const data = (await res.json()) as { sessions: SessionListItem[] };
    set(internalSessionList$, data.sessions);
  } catch (error) {
    throwIfAbort(error);
    const msg =
      error instanceof Error ? error.message : "Failed to load sessions";
    set(internalSessionListError$, msg);
    L.error("Failed to fetch session list:", error);
  } finally {
    set(internalSessionListLoading$, false);
  }
});

export const switchZeroSession$ = command(
  async ({ get, set }, sessionId: string) => {
    // Abort any in-flight polling from the previous session
    const prev = get(pollingAbortController$);
    if (prev) {
      prev.abort();
    }
    set(pollingAbortController$, null);

    // Set session immediately so the UI switches without loading delay
    set(internalSessionId$, sessionId);
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
      const res = await fetchFn(`/api/agent/sessions/${sessionId}`);
      if (!res.ok) {
        set(internalSessionError$, `Failed to load session: ${res.statusText}`);
        return;
      }

      const data = (await res.json()) as {
        chatMessages?: {
          role: "user" | "assistant";
          content: string;
          runId?: string;
          createdAt: string;
        }[];
      };

      const messages: ZeroChatMessage[] = (data.chatMessages ?? []).map(
        (m) => ({
          id: crypto.randomUUID(),
          role: m.role,
          content: m.content,
          runId: m.runId,
        }),
      );

      set(internalMessages$, messages);
    } catch (error) {
      throwIfAbort(error);
      const msg =
        error instanceof Error ? error.message : "Failed to load session";
      set(internalSessionError$, msg);
      L.error("Failed to switch session:", error);
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
      if (data.result?.agentSessionId) {
        const prevSessionId = get(internalSessionId$);
        set(internalSessionId$, data.result.agentSessionId);
        // Update URL only if user is still on the chat page
        if (!prevSessionId && get(zeroInChat$)) {
          set(navigateToZeroSession$, data.result.agentSessionId);
        }
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
