import { command, computed, state, type Computed } from "ccstate";
import type { LogStatus } from "../logs-page/types.ts";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { agentDetail$, refreshAgentInstructions$ } from "./agent-detail.ts";
import { closeInlineRun$ } from "./inline-run.ts";
import { setupPollingLoop$, type PageResult } from "./polling.ts";

const L = logger("Chat");

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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId?: string;
  status?: LogStatus;
  error?: string;
}

// ---------------------------------------------------------------------------
// Per-agent persistent state (survives navigation)
// ---------------------------------------------------------------------------

interface PerAgentChatState {
  messages: ChatMessage[];
  sessionId: string | null;
}

const agentChatCache$ = state<Map<string, PerAgentChatState>>(new Map());

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalPanelOpen$ = state(false);
export const isChatPanelOpen$ = computed((get) => get(internalPanelOpen$));

const internalMessages$ = state<ChatMessage[]>([]);
export const chatMessages$ = computed((get) => get(internalMessages$));

const internalSessionId$ = state<string | null>(null);

const internalActiveRunId$ = state<string | null>(null);

const internalRunStatus$ = state<LogStatus | null>(null);

const internalRunEvents$ = state<Computed<Promise<PageResult>>[]>([]);

const internalSending$ = state(false);
export const chatSending$ = computed((get) => get(internalSending$));

const pollingAbortController$ = state<AbortController | null>(null);

// ---------------------------------------------------------------------------
// Chat input (used by ChatPanel view)
// ---------------------------------------------------------------------------

const internalChatInput$ = state("");
export const chatInput$ = computed((get) => get(internalChatInput$));

export const setChatInput$ = command(({ set }, value: string) => {
  set(internalChatInput$, value);
});

export const clearChatInput$ = command(({ set }) => {
  set(internalChatInput$, "");
});

// ---------------------------------------------------------------------------
// Persistence: save/restore per-agent state
// ---------------------------------------------------------------------------

const saveToCache$ = command(({ get, set }) => {
  const detail = get(agentDetail$);
  if (!detail) {
    return;
  }
  const cache = new Map(get(agentChatCache$));
  cache.set(detail.name, {
    messages: get(internalMessages$),
    sessionId: get(internalSessionId$),
  });
  set(agentChatCache$, cache);
});

export const initChatFromCache$ = command(({ get, set }) => {
  const detail = get(agentDetail$);
  if (!detail) {
    return;
  }
  const cache = get(agentChatCache$);
  const cached = cache.get(detail.name);
  if (cached) {
    set(internalMessages$, cached.messages);
    set(internalSessionId$, cached.sessionId);
  } else {
    set(internalMessages$, []);
    set(internalSessionId$, null);
  }
  // Always reset transient state
  set(internalActiveRunId$, null);
  set(internalRunEvents$, []);
  set(internalRunStatus$, null);
  set(internalSending$, false);
  set(internalPanelOpen$, false);
});

// ---------------------------------------------------------------------------
// Commands: open / close
// ---------------------------------------------------------------------------

export const openChatPanel$ = command(({ set }) => {
  // Close inline run panel first (mutually exclusive)
  set(closeInlineRun$);
  set(internalPanelOpen$, true);
});

export const closeChatPanel$ = command(({ get, set }) => {
  // Abort active polling
  const controller = get(pollingAbortController$);
  if (controller) {
    controller.abort();
    set(pollingAbortController$, null);
  }

  set(internalPanelOpen$, false);

  // Save state to cache for persistence
  set(saveToCache$);
});

// ---------------------------------------------------------------------------
// Commands: send message
// ---------------------------------------------------------------------------

export const sendChatMessage$ = command(
  async ({ get, set }, prompt: string) => {
    const detail = get(agentDetail$);
    if (!detail || !prompt.trim()) {
      return;
    }

    set(internalSending$, true);

    // Add user message
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt.trim(),
    };
    set(internalMessages$, (prev) => [...prev, userMessage]);

    // Add placeholder assistant message
    const assistantPlaceholder: ChatMessage = {
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
        agentComposeId: detail.id,
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
        // Update last assistant message with error
        set(internalMessages$, (prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...updated[updated.length - 1],
            error: errorMsg,
          };
          return updated;
        });
        set(internalSending$, false);
        set(saveToCache$);
        return;
      }

      const data = (await response.json()) as { runId: string };
      const runId = data.runId;

      // Update placeholder with runId
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

      // Abort any existing polling
      const prev = get(pollingAbortController$);
      if (prev) {
        prev.abort();
      }
      const controller = new AbortController();
      set(pollingAbortController$, controller);

      // Start polling
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
          setStatus: (status) => {
            set(internalRunStatus$, status);
          },
        },
        onTerminal: (completedRunId) => {
          set(onRunComplete$, completedRunId).catch((error: unknown) => {
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
      set(saveToCache$);
    }
  },
);

// ---------------------------------------------------------------------------
// On run complete: extract session, update message, refresh instructions
// ---------------------------------------------------------------------------

const onRunComplete$ = command(async ({ get, set }, runId: string) => {
  const status = get(internalRunStatus$);
  const messages = get(internalMessages$);

  // Update the assistant message with final status
  const lastIdx = messages.length - 1;
  if (lastIdx >= 0 && messages[lastIdx].role === "assistant") {
    set(internalMessages$, (prev) => {
      const updated = [...prev];
      updated[lastIdx] = {
        ...updated[lastIdx],
        status: status ?? undefined,
        runId,
      };
      return updated;
    });
  }

  // Clear active run
  set(internalActiveRunId$, null);
  set(saveToCache$);

  // Fetch run details to extract sessionId and result
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

    // Extract result content from telemetry events (primary source)
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

    set(saveToCache$);
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to extract run result:", error);
  }

  // Silently refresh instructions (agent may have modified them)
  try {
    await set(refreshAgentInstructions$);
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to refresh instructions:", error);
  }
});
