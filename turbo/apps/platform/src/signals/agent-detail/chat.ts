import { command, computed, state, type Computed } from "ccstate";
import type { AgentEvent, LogStatus } from "../logs-page/types.ts";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { agentDetail$, refreshAgentInstructions$ } from "./agent-detail.ts";
import { closeInlineRun$ } from "./inline-run.ts";
import { setupPollingLoop$, type PageResult } from "./polling.ts";
import type { SessionListItem } from "@vm0/core";

export type { SessionListItem };

const L = logger("Chat");

// ---------------------------------------------------------------------------
// Streaming state types
// ---------------------------------------------------------------------------

interface ToolUseInfo {
  name: string;
  keyParam: string;
}

export interface ChatStreamingState {
  latestText: string;
  toolUses: ToolUseInfo[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract key parameter from tool input for display. */
export function extractKeyParam(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase();

  if (name === "bash" && typeof input.command === "string") {
    const cmd = input.command;
    return cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
  }
  if (
    (name === "webfetch" || name === "websearch") &&
    typeof input.url === "string"
  ) {
    return input.url;
  }
  if (
    (name === "webfetch" || name === "websearch") &&
    typeof input.query === "string"
  ) {
    return input.query;
  }
  if (["read", "write", "edit", "glob", "grep"].includes(name)) {
    const filePath = input.file_path ?? input.path ?? input.pattern;
    if (typeof filePath === "string") {
      return filePath;
    }
  }
  if (name === "skill" && typeof input.skill === "string") {
    return input.skill;
  }
  return "";
}

interface StreamingEventData {
  subtype?: string;
  message?: {
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }> | null;
  };
}

function isStreamingEventData(data: unknown): data is StreamingEventData {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  if ("subtype" in obj && typeof obj.subtype !== "string") {
    return false;
  }
  return true;
}

/** Extract streaming display state from flat events following the UX spec rules. */
export function extractStreamingState(
  events: AgentEvent[],
): ChatStreamingState {
  let latestText = "";
  let toolUses: ToolUseInfo[] = [];

  for (const event of events) {
    if (!isStreamingEventData(event.eventData)) {
      continue;
    }

    if (event.eventType === "system") {
      if (event.eventData.subtype === "init") {
        // System init shows as a tool-like indicator
        toolUses = [{ name: "Initialize", keyParam: "" }];
      }
      continue;
    }

    if (event.eventType !== "assistant") {
      continue;
    }

    const data = event.eventData;
    const contents = data.message?.content ?? [];

    for (const content of contents) {
      if (content.type === "text" && content.text) {
        // New text appears → replace latestText, clear tool uses (UX rule 3/5)
        latestText = content.text;
        toolUses = [];
      } else if (content.type === "tool_use" && content.name) {
        // Tool use after text → append to tool uses (UX rule 4)
        toolUses.push({
          name: content.name,
          keyParam: extractKeyParam(content.name, content.input ?? {}),
        });
      }
    }
  }

  return { latestText, toolUses };
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
export const currentSessionId$ = computed((get) => get(internalSessionId$));

const internalActiveRunId$ = state<string | null>(null);

const internalRunStatus$ = state<LogStatus | null>(null);

const internalRunEvents$ = state<Computed<Promise<PageResult>>[]>([]);

const internalSending$ = state(false);
export const chatSending$ = computed((get) => get(internalSending$));

/** Derived streaming state from run events — used by chat panel during loading. */
export const chatStreamingState$ = computed(async (get) => {
  const pages = get(internalRunEvents$);
  if (pages.length === 0) {
    return { latestText: "", toolUses: [] };
  }

  const allEvents: AgentEvent[] = [];
  for (const page$ of pages) {
    const page = await get(page$);
    allEvents.push(...page.events);
  }
  allEvents.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  return extractStreamingState(allEvents);
});

const pollingAbortController$ = state<AbortController | null>(null);

// Session list state
const internalSessionList$ = state<SessionListItem[]>([]);
export const sessionList$ = computed((get) => get(internalSessionList$));

const internalSessionListLoading$ = state(false);
export const sessionListLoading$ = computed((get) =>
  get(internalSessionListLoading$),
);

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
// Commands: session list management
// ---------------------------------------------------------------------------

const fetchSessionList$ = command(async ({ get, set }) => {
  const detail = get(agentDetail$);
  if (!detail) {
    return;
  }

  set(internalSessionListLoading$, true);
  try {
    const fetchFn = get(fetch$);
    const res = await fetchFn(
      `/api/agent/sessions?agentComposeId=${encodeURIComponent(detail.id)}`,
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

export const switchSession$ = command(
  async ({ get, set }, sessionId: string) => {
    const detail = get(agentDetail$);
    if (!detail) {
      return;
    }

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

      // Convert stored messages to ChatMessage format (add client-side IDs)
      const messages: ChatMessage[] = (data.chatMessages ?? []).map((m) => ({
        id: crypto.randomUUID(),
        role: m.role,
        content: m.content,
        runId: m.runId,
      }));

      set(internalMessages$, messages);
      set(internalSessionId$, sessionId);
      // Reset transient run state
      set(internalActiveRunId$, null);
      set(internalRunEvents$, []);
      set(internalRunStatus$, null);
      set(internalSending$, false);
      set(saveToCache$);
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to switch session:", error);
    } finally {
      set(internalSessionListLoading$, false);
    }
  },
);

export const startNewSession$ = command(({ set }) => {
  set(internalMessages$, []);
  set(internalSessionId$, null);
  // Reset transient run state
  set(internalActiveRunId$, null);
  set(internalRunEvents$, []);
  set(internalRunStatus$, null);
  set(internalSending$, false);
  set(saveToCache$);
});

// ---------------------------------------------------------------------------
// Commands: open / close
// ---------------------------------------------------------------------------

export const openChatPanel$ = command(({ set }) => {
  // Close inline run panel first (mutually exclusive)
  set(closeInlineRun$);
  set(internalPanelOpen$, true);

  // Fetch session list in background
  set(fetchSessionList$).catch((error: unknown) => {
    throwIfAbort(error);
    L.error("Failed to fetch session list on open:", error);
  });
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

      // Refresh session list after messages are persisted
      set(fetchSessionList$).catch((error: unknown) => {
        throwIfAbort(error);
        L.error("Failed to refresh session list:", error);
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
