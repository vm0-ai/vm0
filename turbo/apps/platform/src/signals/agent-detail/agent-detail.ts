import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { pathParams$, searchParams$, updateSearchParams$ } from "../route.ts";
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

    // Shared agents have scope/agentName format; split for the API
    const slashIndex = name.indexOf("/");
    const isOwner = slashIndex === -1;
    const agentName = isOwner ? name : name.slice(slashIndex + 1);
    const scope = isOwner ? undefined : name.slice(0, slashIndex);

    const params = new URLSearchParams({ name: agentName });
    if (scope) {
      params.set("scope", scope);
    }

    const response = await fetchFn(`/api/agent/composes?${params.toString()}`);

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
// Instructions view mode — synced with ?view= query param
// ---------------------------------------------------------------------------

type InstructionsViewMode = "markdown" | "preview";
const internalInstructionsViewMode$ = state<InstructionsViewMode>("preview");
export const instructionsViewMode$ = computed((get) =>
  get(internalInstructionsViewMode$),
);

function isInstructionsViewMode(v: string): v is InstructionsViewMode {
  return v === "markdown" || v === "preview";
}

export const initInstructionsViewMode$ = command(({ get, set }) => {
  const params = get(searchParams$);
  const view = params.get("view");
  if (view && isInstructionsViewMode(view)) {
    set(internalInstructionsViewMode$, view);
  }
});

export const setInstructionsViewMode$ = command(({ get, set }, v: string) => {
  if (isInstructionsViewMode(v)) {
    set(internalInstructionsViewMode$, v);

    const params = new URLSearchParams(get(searchParams$));
    if (v === "preview") {
      params.delete("view");
    } else {
      params.set("view", v);
    }
    set(updateSearchParams$, params);
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

// ---------------------------------------------------------------------------
// Instructions editing — owner inline editing state
// ---------------------------------------------------------------------------

const editedInstructionsContent$ = state<string | null>(null);

export const editedContent$ = computed((get) =>
  get(editedInstructionsContent$),
);

export const isInstructionsDirty$ = computed((get) => {
  const edited = get(editedInstructionsContent$);
  const instructions = get(agentInstructions$);
  return edited !== null && edited !== (instructions?.content ?? "");
});

export const setEditedContent$ = command(({ set }, value: string) => {
  set(editedInstructionsContent$, value);
});

export const cancelEditInstructions$ = command(({ set }) => {
  set(editedInstructionsContent$, null);
});

const saveInstructionsLoading$ = state(false);
export const isSavingInstructions$ = computed((get) =>
  get(saveInstructionsLoading$),
);

export const saveInstructions$ = command(async ({ get, set }) => {
  const detail = get(agentDetail$);
  const edited = get(editedInstructionsContent$);
  if (!detail || edited === null) {
    return;
  }

  set(saveInstructionsLoading$, true);

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn(
      `/api/agent/composes/${detail.id}/instructions`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: edited }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to save instructions: ${response.statusText}`);
    }

    // Optimistically update the instructions state with the saved content
    // so the UI reflects the change immediately without a re-fetch.
    const current = get(agentInstructions$);
    set(agentInstructionsState$, {
      instructions: {
        content: edited,
        filename: current?.filename ?? null,
      },
      loading: false,
    });

    // Clear editing state
    set(editedInstructionsContent$, null);

    toast.success("Instructions saved");
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to save instructions:", error);
    toast.error("Failed to save instructions");
  } finally {
    set(saveInstructionsLoading$, false);
  }
});
