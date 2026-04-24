import type { RunContextResponse } from "@vm0/core/contracts/zero-runs";
import type { NetworkLogEntry } from "@vm0/core/contracts/runs";
import type { AgentEvent, LogDetail } from "../zero-page/log-types.ts";

export type InspectLogMeta = Partial<LogDetail>;

interface InspectLogJson {
  meta?: InspectLogMeta;
  events?: AgentEvent[];
  context?: RunContextResponse;
  networkLogs?: NetworkLogEntry[];
}

export function parseInspectLog(jsonText: string): {
  meta: InspectLogMeta | null;
  events: AgentEvent[];
  context: RunContextResponse | null;
  networkLogs: NetworkLogEntry[] | null;
} {
  const raw = JSON.parse(jsonText) as InspectLogJson;

  return {
    meta: raw.meta ?? null,
    events: raw.events ?? [],
    context: raw.context ?? null,
    networkLogs: raw.networkLogs ?? null,
  };
}
