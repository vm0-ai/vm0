import { command, computed, state, type Computed } from "ccstate";
import type {
  AgentEvent,
  AgentEventsResponse,
  LogDetail,
  LogStatus,
} from "../logs-page/types.ts";
import { delay } from "signal-timers";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { agentDetail$, fetchAgentInstructions$ } from "./agent-detail.ts";
import { collaborateAgentName } from "../../env.ts";
import { closeInlineRun$ } from "./inline-run.ts";

const L = logger("Collaborate");

const AGENT_EVENTS_PAGE_LIMIT = 30;
const MAX_INTERVAL = 30_000;
const BASE_POLL_INTERVAL = 3000;

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
// Page result & factory (mirrors inline-run.ts)
// ---------------------------------------------------------------------------

interface PageResult {
  events: AgentEvent[];
  hasMore: boolean;
}

function createEventPageComputed(
  runId: string,
  since?: string,
): Computed<Promise<PageResult>> {
  return computed(async (get) => {
    const fetchFn = get(fetch$);
    const params = new URLSearchParams({
      limit: String(AGENT_EVENTS_PAGE_LIMIT),
      order: "asc",
    });
    if (since) {
      params.set("since", String(new Date(since).getTime()));
    }
    const response = await fetchFn(
      `/api/agent/runs/${runId}/telemetry/agent?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch agent events: ${response.statusText}`);
    }
    const data = (await response.json()) as AgentEventsResponse;
    return { events: data.events, hasMore: data.hasMore };
  });
}

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
// Terminal status helper
// ---------------------------------------------------------------------------

function isTerminalStatus(status: LogStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled"
  );
}

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
      await set(setupCollaboratePolling$, controller.signal);
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
// Polling (three-phase, mirrors inline-run.ts)
// ---------------------------------------------------------------------------

const pollNewEvents$ = command(async ({ get, set }, runId: string) => {
  const pages = get(internalRunEvents$);
  if (pages.length === 0) {
    return;
  }

  const lastPage = await get(pages[pages.length - 1]);
  if (lastPage.events.length === 0) {
    const freshPage = createEventPageComputed(runId);
    set(internalRunEvents$, [freshPage]);
    return;
  }

  const lastEvent = lastPage.events[lastPage.events.length - 1];
  const newPage = createEventPageComputed(runId, lastEvent.createdAt);
  const newPageResult = await get(newPage);

  if (newPageResult.events.length > 0) {
    set(internalRunEvents$, (prev) => [...prev, newPage]);
  }
});

const setupCollaboratePolling$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const runId = get(internalActiveRunId$);
    if (!runId) {
      return;
    }

    // Phase 1: Eager initial load
    const firstPage = createEventPageComputed(runId);
    set(internalRunEvents$, [firstPage]);

    let keepLoading = true;
    while (keepLoading && !signal.aborted) {
      const pages = get(internalRunEvents$);
      const lastPage = await get(pages[pages.length - 1]);
      signal.throwIfAborted();
      if (lastPage.hasMore && lastPage.events.length > 0) {
        const lastEvent = lastPage.events[lastPage.events.length - 1];
        const nextPage = createEventPageComputed(runId, lastEvent.createdAt);
        set(internalRunEvents$, (prev) => [...prev, nextPage]);
      } else {
        keepLoading = false;
      }
    }

    // Phase 2: Check if already terminal
    try {
      const fetchFn = get(fetch$);
      const response = await fetchFn(`/api/platform/logs/${runId}`);
      signal.throwIfAborted();
      if (response.ok) {
        const detail = (await response.json()) as LogDetail;
        set(internalRunStatus$, detail.status);
        if (isTerminalStatus(detail.status)) {
          await set(pollNewEvents$, runId);
          signal.throwIfAborted();
          set(onRunComplete$, runId);
          return;
        }
      }
    } catch (error) {
      throwIfAbort(error);
    }

    // Phase 3: Polling loop
    let errorCount = 0;

    while (!signal.aborted) {
      const interval = Math.min(
        BASE_POLL_INTERVAL * 2 ** errorCount,
        MAX_INTERVAL,
      );

      await delay(interval, { signal });
      signal.throwIfAborted();

      try {
        const fetchFn = get(fetch$);
        const response = await fetchFn(`/api/platform/logs/${runId}`);
        signal.throwIfAborted();

        if (response.ok) {
          const detail = (await response.json()) as LogDetail;
          set(internalRunStatus$, detail.status);
          if (isTerminalStatus(detail.status)) {
            await set(pollNewEvents$, runId);
            signal.throwIfAborted();
            set(onRunComplete$, runId);
            return;
          }
        }

        await set(pollNewEvents$, runId);
        signal.throwIfAborted();
        errorCount = 0;
      } catch (error) {
        throwIfAbort(error);
        errorCount++;
      }
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
    .catch(() => {
      // Non-critical: session extraction failure doesn't break UX
    });

  // Refresh instructions (orchestrator may have modified them)
  set(fetchAgentInstructions$).catch(() => {
    // Non-critical
  });

  set(saveToCache$);
});
