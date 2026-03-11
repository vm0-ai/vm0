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
// Session list state
// ---------------------------------------------------------------------------

const internalSessionList$ = state<SessionListItem[]>([]);
export const zeroSessionList$ = computed((get) => get(internalSessionList$));

const internalSessionListLoading$ = state(false);
export const zeroSessionListLoading$ = computed((get) =>
  get(internalSessionListLoading$),
);

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

// ---------------------------------------------------------------------------
// Commands: send intro message (fire-and-forget, creates a session)
// ---------------------------------------------------------------------------

/**
 * Sends a prompt to the default agent, polls until complete, then refreshes
 * the session list. Used after onboarding to auto-create the first session.
 */
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

      // Internal polling state
      const runEvents$ = state<Computed<Promise<PageResult>>[]>([]);
      const runStatus$ = state<LogStatus | null>(null);

      const controller = new AbortController();

      // Poll until terminal
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
          // Refresh session list so the new session appears in sidebar
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
