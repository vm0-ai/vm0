import { command, computed, state } from "ccstate";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import type { AgentEvent } from "../zero-page/log-types.ts";
import { parseInspectLog, type InspectLogMeta } from "./inspect-log-parser.ts";
import { logger } from "../log.ts";
import { settle } from "../utils.ts";

const L = logger("InspectLogSignals");
const MAX_INSPECT_LOG_FILE_SIZE_BYTES = 25 * 1024 * 1024;

function inspectLogLoadErrorMessage(): string {
  return "Could not load JSON file. Upload an exported activity log JSON file.";
}

function invalidInspectLogMessage(): string {
  return "Invalid JSON file. Upload an exported activity log JSON file.";
}

function oversizedInspectLogMessage(): string {
  return "JSON file is too large. Upload an exported activity log JSON file under 25 MB.";
}

export interface InspectLogData {
  meta: InspectLogMeta | null;
  events: AgentEvent[];
  context: RunContextResponse | null;
  networkLogs: NetworkLogEntry[] | null;
}

const internalInspectLogData$ = state<InspectLogData | null>(null);
const internalInspectLogLoadError$ = state<string | null>(null);
const internalInspectStepSearch$ = state("");
const internalInspectLogLoadGeneration$ = state(0);

export const inspectLogData$ = computed((get) => {
  return get(internalInspectLogData$);
});

export const inspectLogLoadError$ = computed((get) => {
  return get(internalInspectLogLoadError$);
});

export const loadInspectLogFile$ = command(
  async ({ get, set }, file: File, signal: AbortSignal) => {
    const generation = get(internalInspectLogLoadGeneration$) + 1;
    set(internalInspectLogLoadGeneration$, generation);
    set(internalInspectLogLoadError$, null);

    if (file.size > MAX_INSPECT_LOG_FILE_SIZE_BYTES) {
      L.warn("Inspect log file is too large", file.name, file.size);
      set(internalInspectLogData$, null);
      set(internalInspectLogLoadError$, oversizedInspectLogMessage());
      set(internalInspectStepSearch$, "");
      return;
    }

    const textResult = await settle(file.text(), signal);
    signal.throwIfAborted();
    if (generation !== get(internalInspectLogLoadGeneration$)) {
      return;
    }
    if (!textResult.ok) {
      L.warn("Failed to read inspect log file", file.name, textResult.error);
      set(internalInspectLogData$, null);
      set(internalInspectLogLoadError$, inspectLogLoadErrorMessage());
      set(internalInspectStepSearch$, "");
      return;
    }

    const data = parseInspectLog(textResult.value);
    if (!data) {
      L.warn("Failed to parse inspect log file", file.name);
      set(internalInspectLogData$, null);
      set(internalInspectLogLoadError$, invalidInspectLogMessage());
      set(internalInspectStepSearch$, "");
      return;
    }
    if (generation !== get(internalInspectLogLoadGeneration$)) {
      return;
    }
    L.info("Loaded inspect log file", file.name);
    set(internalInspectLogData$, data);
    set(internalInspectLogLoadError$, null);
    set(internalInspectStepSearch$, "");
  },
);

// ---------------------------------------------------------------------------
// Inspect step search — component-local filter for the inspect detail view
// ---------------------------------------------------------------------------

/** Current step search filter for the inspect detail view. */
export const inspectStepSearch$ = computed((get) => {
  return get(internalInspectStepSearch$);
});

/** Update the inspect step search filter. */
export const setInspectStepSearch$ = command(({ set }, value: string) => {
  set(internalInspectStepSearch$, value);
});
