import { command, computed, state } from "ccstate";
import type { RunContextResponse, NetworkLogEntry } from "@vm0/core";
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

export const inspectLogData$ = computed((get) => {
  return get(internalInspectLogData$);
});

export const loadInspectLogFile$ = command(
  async ({ set }, file: File, _signal: AbortSignal) => {
    const text = await file.text();
    const data = parseInspectLog(text);
    L.info("Loaded inspect log file", file.name);
    set(internalInspectLogData$, data);
  },
);
