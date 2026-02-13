import { command, computed, state } from "ccstate";
import { pathParams$ } from "../route.ts";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import type { AgentDetail, AgentInstructions } from "./types.ts";

const L = logger("AgentDetail");

// ---------------------------------------------------------------------------
// Agent name — derived from URL path param :name
// ---------------------------------------------------------------------------

export const agentName$ = computed((get) => {
  const params = get(pathParams$) as { name?: string } | undefined;
  return params?.name ?? null;
});

// ---------------------------------------------------------------------------
// Agent detail — fetches compose data by name
// ---------------------------------------------------------------------------

interface AgentDetailState {
  detail: AgentDetail | null;
  loading: boolean;
  error: string | null;
}

const agentDetailState$ = state<AgentDetailState>({
  detail: null,
  loading: false,
  error: null,
});

export const agentDetail$ = computed((get) => get(agentDetailState$).detail);
export const agentDetailLoading$ = computed(
  (get) => get(agentDetailState$).loading,
);
export const agentDetailError$ = computed(
  (get) => get(agentDetailState$).error,
);

export const isOwner$ = computed((get) => {
  const detail = get(agentDetail$);
  return detail?.isOwner ?? false;
});

export const fetchAgentDetail$ = command(async ({ get, set }) => {
  const name = get(agentName$);
  if (!name) {
    L.error("No agent name in URL");
    return;
  }

  set(agentDetailState$, (prev) => ({ ...prev, loading: true, error: null }));

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn(
      `/api/agent/composes?name=${encodeURIComponent(name)}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch agent: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      id: string;
      name: string;
      headVersionId: string | null;
      content: AgentDetail["content"];
      createdAt: string;
      updatedAt: string;
    };

    // Determine ownership: if the URL name contains /, it's a shared agent
    const isOwner = !name.includes("/");

    set(agentDetailState$, {
      detail: { ...data, isOwner },
      loading: false,
      error: null,
    });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch agent detail:", error);
    set(agentDetailState$, (prev) => ({
      ...prev,
      loading: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }));
  }
});

// ---------------------------------------------------------------------------
// Agent instructions — fetches instructions content
// ---------------------------------------------------------------------------

interface AgentInstructionsState {
  instructions: AgentInstructions | null;
  loading: boolean;
}

const agentInstructionsState$ = state<AgentInstructionsState>({
  instructions: null,
  loading: false,
});

export const agentInstructions$ = computed(
  (get) => get(agentInstructionsState$).instructions,
);
export const agentInstructionsLoading$ = computed(
  (get) => get(agentInstructionsState$).loading,
);

export const fetchAgentInstructions$ = command(async ({ get, set }) => {
  const detail = get(agentDetail$);
  if (!detail) {
    return;
  }

  set(agentInstructionsState$, { instructions: null, loading: true });

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn(
      `/api/agent/composes/${detail.id}/instructions`,
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch instructions: ${response.statusText}`);
    }

    const data = (await response.json()) as AgentInstructions;
    set(agentInstructionsState$, { instructions: data, loading: false });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch instructions:", error);
    set(agentInstructionsState$, { instructions: null, loading: false });
  }
});
