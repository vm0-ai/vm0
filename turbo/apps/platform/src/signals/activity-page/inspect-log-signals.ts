import { command, computed, state } from "ccstate";
import type { AgentEvent } from "../zero-page/log-types.ts";
import type { InspectLogMeta } from "./inspect-log-parser.ts";

export interface InspectLogData {
  meta: InspectLogMeta | null;
  events: AgentEvent[];
}

const internalInspectLogData$ = state<InspectLogData | null>(null);

export const inspectLogData$ = computed((get) => {
  return get(internalInspectLogData$);
});

export const setInspectLogData$ = command(({ set }, data: InspectLogData) => {
  set(internalInspectLogData$, data);
});

export const clearInspectLogData$ = command(({ set }) => {
  set(internalInspectLogData$, null);
});
