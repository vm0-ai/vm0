import {
  runContextResponseSchema,
  type RunContextResponse,
} from "@vm0/api-contracts/contracts/zero-runs";
import {
  networkLogEntrySchema,
  type NetworkLogEntry,
} from "@vm0/api-contracts/contracts/runs";
import type { AgentEvent, LogDetail } from "../zero-page/log-types.ts";

export type InspectLogMeta = Partial<LogDetail>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAgentEvent(value: unknown): AgentEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.sequenceNumber !== "number" ||
    !Number.isFinite(value.sequenceNumber) ||
    typeof value.eventType !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    sequenceNumber: value.sequenceNumber,
    eventType: value.eventType,
    eventData: value.eventData,
    createdAt: value.createdAt,
  };
}

function parseAgentEvents(value: unknown): AgentEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const event = parseAgentEvent(item);
    return event ? [event] : [];
  });
}

function parseRunContext(value: unknown): RunContextResponse | null {
  const parsed = runContextResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseNetworkLogs(value: unknown): NetworkLogEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.flatMap((item) => {
    const parsed = networkLogEntrySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parseInspectLog(jsonText: string): {
  meta: InspectLogMeta | null;
  events: AgentEvent[];
  context: RunContextResponse | null;
  networkLogs: NetworkLogEntry[] | null;
} {
  const rawValue = JSON.parse(jsonText) as unknown;
  const raw = isRecord(rawValue) ? rawValue : {};

  return {
    meta: isRecord(raw.meta) ? raw.meta : null,
    events: parseAgentEvents(raw.events),
    context: parseRunContext(raw.context),
    networkLogs: parseNetworkLogs(raw.networkLogs),
  };
}
