import { command, computed, state, type Computed } from "ccstate";
import type { LogStatus } from "../logs-page/types.ts";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { setupPollingLoop$, type PageResult } from "../agent-detail/polling.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import { navigateToZeroSession$, zeroChatAgentId$ } from "./zero-nav.ts";
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

/** Start an agent run and return the runId, or null on failure. */
async function startAgentRun(
  fetchFn: typeof fetch,
  composeId: string,
  prompt: string,
  sessionId?: string | null,
): Promise<string | null> {
  const body: Record<string, string> = {
    agentComposeId: composeId,
    prompt: prompt.trim(),
  };
  if (sessionId) {
    body.sessionId = sessionId;
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
    // Set session immediately so the UI switches without loading delay
    set(internalSessionId$, sessionId);
    set(internalMessages$, []);
    set(internalActiveRunId$, null);
    set(internalRunEvents$, []);
    set(internalRunStatus$, null);
    set(internalRunError$, null);
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

export const startNewZeroSession$ = command(({ set }) => {
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

export const sendZeroChatMessage$ = command(
  async ({ get, set }, prompt: string) => {
    const chatAgentId = get(zeroChatAgentId$);
    const composeId =
      chatAgentId ?? (await get(zeroOnboardingStatus$)).defaultAgentComposeId;
    if (!composeId || !prompt.trim()) {
      return;
    }

    set(internalSending$, true);

    // Build full prompt with attachments
    const attachments = get(internalAttachments$).filter((a) => !a.uploading);
    let fullPrompt = prompt.trim();
    if (attachments.length > 0) {
      const attachmentLines = attachments.map(
        (a) =>
          `[Attached file: ${a.filename}](${a.url})\nDownload with: curl -sL -o "${a.filename}" "${a.url}"`,
      );
      fullPrompt = `${fullPrompt}\n\n${attachmentLines.join("\n")}`;
    }

    // Add user message (show original prompt + attachment names in UI)
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
    set(internalMessages$, (prev) => [...prev, userMessage]);
    set(internalAttachments$, []);

    // Add placeholder assistant message
    const assistantPlaceholder: ZeroChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
    };
    set(internalMessages$, (prev) => [...prev, assistantPlaceholder]);

    try {
      const fetchFn = get(fetch$);
      const sessionId = get(internalSessionId$);

      const runId = await startAgentRun(
        fetchFn,
        composeId,
        fullPrompt,
        sessionId,
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
      set(internalRunEvents$, []);
      set(internalRunStatus$, null);
      set(internalRunError$, null);

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
        // Update URL when a new session is created
        if (!prevSessionId) {
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

// ---------------------------------------------------------------------------
// Commands: send intro message (fire-and-forget, creates a session)
// ---------------------------------------------------------------------------

export const sendZeroIntroMessage$ = command(
  async ({ get, set }, prompt: string) => {
    const status = await get(zeroOnboardingStatus$);
    const composeId = status.defaultAgentComposeId;
    if (!composeId || !prompt.trim()) {
      return;
    }

    try {
      const fetchFn = get(fetch$);

      const runId = await startAgentRun(fetchFn, composeId, prompt);

      if (!runId) {
        L.error("Intro message run failed");
        return;
      }

      const runEvents$ = state<Computed<Promise<PageResult>>[]>([]);
      const runStatus$ = state<LogStatus | null>(null);
      const controller = new AbortController();

      await set(setupPollingLoop$, {
        runId,
        signal: controller.signal,
        state: {
          get events$() {
            return get(runEvents$);
          },
          setEvents: (updater) => {
            set(runEvents$, updater);
          },
          setStatus: (s) => {
            set(runStatus$, s);
          },
        },
        onTerminal: () => {
          set(fetchZeroSessionList$).catch((error: unknown) => {
            throwIfAbort(error);
            L.error("Failed to refresh session list:", error);
          });
        },
      });
    } catch (error) {
      throwIfAbort(error);
      L.error("Intro message error:", error);
    }
  },
);
