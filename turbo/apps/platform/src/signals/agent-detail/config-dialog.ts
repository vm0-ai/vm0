import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { stringify, parse } from "yaml";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { agentDetail$, fetchAgentDetail$ } from "./agent-detail.ts";
import type { AgentDetail } from "./types.ts";

const L = logger("ConfigDialog");

// ---------------------------------------------------------------------------
// Dialog open/close state
// ---------------------------------------------------------------------------

const internalOpen$ = state(false);
export const configDialogOpen$ = computed((get) => get(internalOpen$));

// ---------------------------------------------------------------------------
// Editable compose — single source of truth for both tabs
// ---------------------------------------------------------------------------

type ComposeContent = NonNullable<AgentDetail["content"]>;

const internalEditableCompose$ = state<ComposeContent | null>(null);
export const editableCompose$ = computed((get) =>
  get(internalEditableCompose$),
);

// ---------------------------------------------------------------------------
// YAML text for the YAML tab — derived from editable compose
// ---------------------------------------------------------------------------

const internalYamlText$ = state("");
export const yamlText$ = computed((get) => get(internalYamlText$));

// ---------------------------------------------------------------------------
// YAML parse error (shown inline in YAML tab)
// ---------------------------------------------------------------------------

const internalYamlError$ = state<string | null>(null);
export const yamlError$ = computed((get) => get(internalYamlError$));

// ---------------------------------------------------------------------------
// Active tab
// ---------------------------------------------------------------------------

type ConfigTab = "yaml" | "forms";
const internalActiveTab$ = state<ConfigTab>("yaml");
export const configActiveTab$ = computed((get) => get(internalActiveTab$));

export const setConfigActiveTab$ = command(({ set }, tab: string) => {
  if (tab === "yaml" || tab === "forms") {
    set(internalActiveTab$, tab);
  }
});

// ---------------------------------------------------------------------------
// Saving state
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);
export const configDialogSaving$ = computed((get) => get(internalSaving$));

// ---------------------------------------------------------------------------
// Save error
// ---------------------------------------------------------------------------

const internalSaveError$ = state<string | null>(null);
export const configDialogSaveError$ = computed((get) =>
  get(internalSaveError$),
);

// ---------------------------------------------------------------------------
// Open dialog — initialises editable state from current agent detail
// ---------------------------------------------------------------------------

export const openConfigDialog$ = command(({ get, set }) => {
  const detail = get(agentDetail$);
  if (!detail?.content) {
    return;
  }

  const content = detail.content;
  set(internalEditableCompose$, structuredClone(content));
  set(internalYamlText$, stringify(content));
  set(internalYamlError$, null);
  set(internalSaveError$, null);
  set(internalActiveTab$, "yaml");
  set(internalOpen$, true);
});

// ---------------------------------------------------------------------------
// Close dialog
// ---------------------------------------------------------------------------

export const closeConfigDialog$ = command(({ set }) => {
  set(internalOpen$, false);
});

// ---------------------------------------------------------------------------
// Update from Forms tab — field-level updates to the compose
// ---------------------------------------------------------------------------

export const updateComposeField$ = command(
  ({ get, set }, field: string, value: string) => {
    const compose = get(internalEditableCompose$);
    if (!compose) {
      return;
    }

    const agentKeys = Object.keys(compose.agents);
    const firstKey = agentKeys[0];
    if (!firstKey) {
      return;
    }

    const updated = structuredClone(compose);
    const agent = updated.agents[firstKey];
    if (!agent) {
      return;
    }

    switch (field) {
      case "description": {
        agent.description = value;
        break;
      }
      case "framework": {
        agent.framework = value;
        break;
      }
      case "instructions": {
        agent.instructions = value || undefined;
        break;
      }
    }

    set(internalEditableCompose$, updated);
    set(internalYamlText$, stringify(updated));
    set(internalYamlError$, null);
  },
);

// ---------------------------------------------------------------------------
// Update from YAML tab — parse YAML and update compose
// ---------------------------------------------------------------------------

export const updateYamlText$ = command(({ set }, text: string) => {
  set(internalYamlText$, text);

  try {
    const parsed = parse(text) as ComposeContent;

    // Basic validation: must have version and agents
    if (!parsed || typeof parsed !== "object" || !parsed.agents) {
      set(internalYamlError$, "Invalid YAML: must contain 'agents' field");
      return;
    }

    set(internalEditableCompose$, parsed);
    set(internalYamlError$, null);
  } catch (error) {
    throwIfAbort(error);
    set(
      internalYamlError$,
      error instanceof Error ? error.message : "Invalid YAML syntax",
    );
  }
});

// ---------------------------------------------------------------------------
// Save — POST to /api/agent/composes
// ---------------------------------------------------------------------------

export const saveConfigDialog$ = command(async ({ get, set }) => {
  const compose = get(internalEditableCompose$);
  const detail = get(agentDetail$);
  if (!compose || !detail) {
    return;
  }

  set(internalSaving$, true);
  set(internalSaveError$, null);

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/agent/composes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: compose }),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(
        errorData?.message ?? `Save failed: ${response.statusText}`,
      );
    }

    // Refresh agent detail and close dialog
    await set(fetchAgentDetail$);
    set(internalOpen$, false);
    toast.success("Agent configuration saved");
  } catch (error) {
    throwIfAbort(error);
    const message = error instanceof Error ? error.message : "Failed to save";
    L.error("Failed to save config:", error);
    set(internalSaveError$, message);
  } finally {
    set(internalSaving$, false);
  }
});
