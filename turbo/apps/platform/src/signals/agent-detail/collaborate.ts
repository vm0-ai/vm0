import { command, computed, state, type Computed } from "ccstate";
import type { AgentEvent, LogStatus } from "../logs-page/types.ts";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { agentDetail$, fetchAgentInstructions$ } from "./agent-detail.ts";
import { collaborateAgentName } from "../../env.ts";
import { closeInlineRun$ } from "./inline-run.ts";
import { setupPollingLoop$, type PageResult } from "./polling.ts";

const L = logger("Collaborate");

// ---------------------------------------------------------------------------
// Chat message types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  runId?: string;
  status?: LogStatus;
  error?: string;
}

// ---------------------------------------------------------------------------
// Per-agent persistent state (survives navigation)
// ---------------------------------------------------------------------------

interface PerAgentCollaborateState {
  messages: ChatMessage[];
  sessionId: string | null;
}

const agentCollaborateCache$ = state<Map<string, PerAgentCollaborateState>>(
  new Map(),
);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const internalPanelOpen$ = state(false);
export const isCollaboratePanelOpen$ = computed((get) =>
  get(internalPanelOpen$),
);

const internalMessages$ = state<ChatMessage[]>([]);
export const collaborateMessages$ = computed((get) => get(internalMessages$));

const internalSessionId$ = state<string | null>(null);

const internalActiveRunId$ = state<string | null>(null);
export const collaborateActiveRunId$ = computed((get) =>
  get(internalActiveRunId$),
);

const internalRunStatus$ = state<LogStatus | null>(null);
export const collaborateRunStatus$ = computed((get) => get(internalRunStatus$));

const internalRunEvents$ = state<Computed<Promise<PageResult>>[]>([]);

const internalSending$ = state(false);
export const collaborateSending$ = computed((get) => get(internalSending$));

const internalOrchestratorComposeId$ = state<string | null>(null);

const pollingAbortController$ = state<AbortController | null>(null);

// ---------------------------------------------------------------------------
// Feature availability
// ---------------------------------------------------------------------------

export const isCollaborateAvailable$ = computed(() => {
  return collaborateAgentName.length > 0;
});

// ---------------------------------------------------------------------------
// Chat input (used by CollaboratePanel view)
// ---------------------------------------------------------------------------

const internalChatInput$ = state("");
export const collaborateChatInput$ = computed((get) => get(internalChatInput$));

export const setCollaborateChatInput$ = command(({ set }, value: string) => {
  set(internalChatInput$, value);
});

export const clearCollaborateChatInput$ = command(({ set }) => {
  set(internalChatInput$, "");
});

// ---------------------------------------------------------------------------
// Derived: flatten current run events
// ---------------------------------------------------------------------------

export const allCollaborateRunEvents$ = computed(async (get) => {
  const pages = get(internalRunEvents$);
  if (pages.length === 0) {
    return [] as AgentEvent[];
  }
  const results = await Promise.all(pages.map((p) => get(p)));
  const all = results.flatMap((r) => r.events);

  const seen = new Set<number>();
  return all.filter((e) => {
    if (seen.has(e.sequenceNumber)) {
      return false;
    }
    seen.add(e.sequenceNumber);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Persistence: save/restore per-agent state
// ---------------------------------------------------------------------------

const saveToCache$ = command(({ get, set }) => {
  const detail = get(agentDetail$);
  if (!detail) {
    return;
  }
  const cache = new Map(get(agentCollaborateCache$));
  cache.set(detail.name, {
    messages: get(internalMessages$),
    sessionId: get(internalSessionId$),
  });
  set(agentCollaborateCache$, cache);
});

export const initCollaborateFromCache$ = command(({ get, set }) => {
  const detail = get(agentDetail$);
  if (!detail) {
    return;
  }
  const cache = get(agentCollaborateCache$);
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
// Orchestrator resolution
// ---------------------------------------------------------------------------

const resolveOrchestratorAgent$ = command(async ({ get, set }) => {
  const existing = get(internalOrchestratorComposeId$);
  if (existing) {
    return existing;
  }

  if (!collaborateAgentName) {
    throw new Error("VITE_COLLABORATE_AGENT is not configured");
  }

  const fetchFn = get(fetch$);
  const params = new URLSearchParams({ name: collaborateAgentName });
  const response = await fetchFn(`/api/agent/composes?${params.toString()}`);

  if (!response.ok) {
    throw new Error(
      `Failed to resolve orchestrator agent "${collaborateAgentName}": ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { id: string };
  set(internalOrchestratorComposeId$, data.id);
  return data.id;
});

// ---------------------------------------------------------------------------
// Commands: open / close
// ---------------------------------------------------------------------------

export const openCollaboratePanel$ = command(({ set }) => {
  // Close inline run panel first (mutually exclusive)
  set(closeInlineRun$);
  set(internalPanelOpen$, true);
});

export const closeCollaboratePanel$ = command(({ get, set }) => {
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

export const sendCollaborateMessage$ = command(
  async ({ get, set }, prompt: string) => {
    const detail = get(agentDetail$);
    if (!detail || !prompt.trim()) {
      return;
    }

    set(internalSending$, true);

    // Add user message
    const userMessage: ChatMessage = { role: "user", content: prompt.trim() };
    set(internalMessages$, (prev) => [...prev, userMessage]);

    // Add placeholder assistant message
    const assistantPlaceholder: ChatMessage = {
      role: "assistant",
      content: "",
    };
    set(internalMessages$, (prev) => [...prev, assistantPlaceholder]);

    try {
      const orchestratorComposeId = await set(resolveOrchestratorAgent$);

      const fetchFn = get(fetch$);
      const sessionId = get(internalSessionId$);

      const body: Record<string, unknown> = {
        agentComposeId: orchestratorComposeId,
        prompt: prompt.trim(),
        vars: {
          TARGET_AGENT_COMPOSE_ID: detail.id,
          TARGET_AGENT_NAME: detail.name,
        },
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
            role: "assistant",
            content: "",
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
          set(onRunComplete$, completedRunId);
        },
      });
    } catch (error) {
      throwIfAbort(error);
      L.error("Collaborate send error:", error);
      set(internalMessages$, (prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: "",
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

const onRunComplete$ = command(({ get, set }, runId: string) => {
  // Extract session from run status for next turn
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

  // Fetch session info from run result to get agentSessionId
  const fetchFn = get(fetch$);
  fetchFn(`/api/agent/runs/${runId}`)
    .then(async (res) => {
      if (res.ok) {
        const data = (await res.json()) as {
          result?: { agentSessionId?: string };
        };
        if (data.result?.agentSessionId) {
          set(internalSessionId$, data.result.agentSessionId);
          set(saveToCache$);
        }
      }
    })
    .catch((error: unknown) => {
      L.error("Failed to extract session:", error);
    });

  // Refresh instructions (orchestrator may have modified them)
  set(fetchAgentInstructions$).catch((error: unknown) => {
    L.error("Failed to refresh instructions:", error);
  });

  set(saveToCache$);
});
