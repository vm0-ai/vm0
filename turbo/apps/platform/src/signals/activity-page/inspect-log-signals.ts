import { command, computed, state } from "ccstate";
import type { AgentEvent } from "../zero-page/log-types.ts";
import {
  parseInspectLogCsv,
  type InspectLogMeta,
} from "./inspect-log-parser.ts";
import { logger } from "../log.ts";

const L = logger("InspectLogSignals");

export interface InspectLogData {
  meta: InspectLogMeta | null;
  events: AgentEvent[];
}

const internalInspectLogData$ = state<InspectLogData | null>(null);

export const inspectLogData$ = computed((get) => {
  return get(internalInspectLogData$);
});

export const clearInspectLogData$ = command(({ set }) => {
  set(internalInspectLogData$, null);
});

export const loadInspectLogFile$ = command(async ({ set }, file: File) => {
  const text = await file.text();
  const data = parseInspectLogCsv(text);
  L.info("Loaded inspect log file", file.name);
  set(internalInspectLogData$, data);
});
