import { command, computed, state } from "ccstate";
import { zeroAgentsByIdContract } from "@vm0/core";
import { throwIfAbort } from "../../utils.ts";
import { logger } from "../../log.ts";
import { zeroClient$ } from "../../api-client.ts";
import type { AgentDetail } from "../agent-types.ts";
import { agentName$ } from "./agent-name.ts";

const L = logger("ZeroJobDetail");

// ---------------------------------------------------------------------------
// Agent detail
// ---------------------------------------------------------------------------

interface ZeroJobDetailState {
  detail: AgentDetail | null;
  loading: boolean;
  error: string | null;
}

const detailState$ = state<ZeroJobDetailState>({
  detail: null,
  loading: false,
  error: null,
});

export const zeroJobDetail$ = computed((get) => {
  return get(detailState$).detail;
});
export const zeroJobDetailLoading$ = computed((get) => {
  return get(detailState$).loading;
});
export const zeroJobDetailError$ = computed((get) => {
  return get(detailState$).error;
});

/** Reset detail state to initial values. */
export const resetDetailState$ = command(({ set }) => {
  set(detailState$, { detail: null, loading: false, error: null });
});

export const fetchZeroJobDetail$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const name = get(agentName$);
    if (!name) {
      return;
    }

    set(detailState$, (prev) => {
      return { ...prev, loading: true, error: null };
    });

    try {
      const client = get(zeroClient$)(zeroAgentsByIdContract);
      const result = await client.get({ params: { id: name } });
      if (result.status !== 200) {
        throw new Error(`Failed to fetch agent (${result.status})`);
      }

      set(detailState$, {
        detail: result.body,
        loading: false,
        error: null,
      });
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to fetch agent detail:", error);
      set(detailState$, (prev) => {
        return {
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      });
    }
  },
);
