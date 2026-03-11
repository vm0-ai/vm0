import { command, computed, state, type Computed } from "ccstate";
import type { LogStatus } from "../logs-page/types.ts";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { setupPollingLoop$, type PageResult } from "../agent-detail/polling.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import type { SessionListItem } from "@vm0/core";

const L = logger("ZeroChat");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Scan telemetry event pages for the last "result" event content. */
async function extractResultFromEvents(
  pages: Computed<Promise<PageResult>>[],
  get: (c: Computed<Promise<PageResult>>) => Promise<PageResult>,
): Promise<string> {
  let result = "";
  for (const page$ of pages) {
    const page = await get(page$);
    for (const event of page.events) {
      if (event.eventType === "result") {
        const data = event.eventData as { result?: string };
        if (data.result) {
          result = data.result;
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Chat message types
// ---------------------------------------------------------------------------

export interface ZeroChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId?: string;
  status?: LogStatus;
  error?: string;
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

// Chat input
const internalChatInput$ = state("");
export const zeroChatInput$ = computed((get) => get(internalChatInput$));

export const setZeroChatInput$ = command(({ set }, value: string) => {
  set(internalChatInput$, value);
});

export const clearZeroChatInput$ = command(({ set }) => {
  set(internalChatInput$, "");
});

// ---------------------------------------------------------------------------
// Commands: session list management
// ---------------------------------------------------------------------------

export const fetchZeroSessionList$ = command(async ({ get, set }) => {
  const status = await get(zeroOnboardingStatus$);
  const composeId = status.defaultAgentComposeId;
  if (!composeId) {
    return;
  }

  set(internalSessionListLoading$, true);
  try {
    const fetchFn = get(fetch$);
    const res = await fetchFn(
      `/api/agent/sessions?agentComposeId=${encodeURIComponent(composeId)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as { sessions: SessionListItem[] };
      set(internalSessionList$, data.sessions);
    }
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch session list:", error);
  } finally {
    set(internalSessionListLoading$, false);
  }
});

export const switchZeroSession$ = command(
  async ({ get, set }, sessionId: string) => {
    set(internalSessionListLoading$, true);
    try {
      const fetchFn = get(fetch$);
      const res = await fetchFn(`/api/agent/sessions/${sessionId}`);
      if (!res.ok) {
        L.error("Failed to fetch session:", res.statusText);
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
      set(internalSessionId$, sessionId);
      set(internalActiveRunId$, null);
      set(internalRunEvents$, []);
      set(internalRunStatus$, null);
      set(internalRunError$, null);
      set(internalSending$, false);
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to switch session:", error);
    } finally {
      set(internalSessionListLoading$, false);
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
    const status = await get(zeroOnboardingStatus$);
    const composeId = status.defaultAgentComposeId;
    if (!composeId || !prompt.trim()) {
      return;
    }

    set(internalSending$, true);

    // Add user message
    const userMessage: ZeroChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt.trim(),
    };
    set(internalMessages$, (prev) => [...prev, userMessage]);

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

      const body: {
        agentComposeId: string;
        prompt: string;
        sessionId?: string;
      } = {
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
        const errorData = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        const errorMsg =
          errorData?.message ?? `Run failed: ${response.statusText}`;
        set(internalMessages$, (prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            error: errorMsg,
          };
          return updated;
        });
        set(internalSending$, false);
        return;
      }

      const data = (await response.json()) as { runId: string };
      const runId = data.runId;

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

    // Persist messages to server, then refresh session list
    const sessionId = get(internalSessionId$);
    const currentMessages = get(internalMessages$);
    const assistantIdx = sessionId
      ? currentMessages.findIndex(
          (m) => m.role === "assistant" && m.runId === runId,
        )
      : -1;
    const userMsg =
      assistantIdx > 0 ? currentMessages[assistantIdx - 1] : undefined;
    const assistantMsg =
      assistantIdx > 0 ? currentMessages[assistantIdx] : undefined;

    if (sessionId && userMsg?.role === "user" && assistantMsg) {
      try {
        await fetchFn(`/api/agent/sessions/${sessionId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              { role: "user", content: userMsg.content },
              { role: "assistant", content: assistantMsg.content, runId },
            ],
          }),
        });
      } catch (error) {
        throwIfAbort(error);
        L.error("Failed to persist messages:", error);
      }

      // Refresh session list
      set(fetchZeroSessionList$).catch((error: unknown) => {
        throwIfAbort(error);
        L.error("Failed to refresh session list:", error);
      });
    }
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

      const response = await fetchFn("/api/agent/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: composeId,
          prompt: prompt.trim(),
        }),
      });

      if (!response.ok) {
        L.error("Intro message run failed:", response.statusText);
        return;
      }

      const data = (await response.json()) as { runId: string };
      const runId = data.runId;

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
