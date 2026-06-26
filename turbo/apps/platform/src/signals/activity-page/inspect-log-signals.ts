import { command, computed, state } from "ccstate";
import type { RunContextResponse } from "@vm0/api-contracts/contracts/zero-runs";
import type { NetworkLogEntry } from "@vm0/api-contracts/contracts/runs";
import type { AgentEvent } from "../zero-page/log-types.ts";
import { parseInspectLog, type InspectLogMeta } from "./inspect-log-parser.ts";
import { logger } from "../log.ts";

const L = logger("InspectLogSignals");

export interface InspectLogData {
  meta: InspectLogMeta | null;
  events: AgentEvent[];
  context: RunContextResponse | null;
  networkLogs: NetworkLogEntry[] | null;
}

const internalInspectLogData$ = state<InspectLogData | null>(null);
const internalInspectStepSearch$ = state("");
const internalInspectLogLoadGeneration$ = state(0);

export const inspectLogData$ = computed((get) => {
  return get(internalInspectLogData$);
});

export const loadInspectLogFile$ = command(
  async ({ get, set }, file: File, signal: AbortSignal) => {
    const generation = get(internalInspectLogLoadGeneration$) + 1;
    set(internalInspectLogLoadGeneration$, generation);
    const text = await file.text();
    signal.throwIfAborted();
    if (generation !== get(internalInspectLogLoadGeneration$)) {
      return;
    }
    const data = parseInspectLog(text);
    if (generation !== get(internalInspectLogLoadGeneration$)) {
      return;
    }
    L.info("Loaded inspect log file", file.name);
    set(internalInspectLogData$, data);
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
