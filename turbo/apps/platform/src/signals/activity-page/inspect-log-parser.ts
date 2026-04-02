import Papa from "papaparse";
import type { AgentEvent, LogDetail } from "../zero-page/log-types.ts";

const META_PREFIX = "# __vm0_meta__:";

export type InspectLogMeta = Partial<LogDetail>;

interface CsvRow {
  sequenceNumber: string;
  eventType: string;
  eventData: string;
  createdAt: string;
}

export function parseInspectLogCsv(csvText: string): {
  meta: InspectLogMeta | null;
  events: AgentEvent[];
} {
  let meta: InspectLogMeta | null = null;
  let textToParse = csvText;

  // Extract metadata comment line if present
  const firstNewline = csvText.indexOf("\n");
  const firstLine =
    firstNewline === -1 ? csvText : csvText.slice(0, firstNewline);

  if (firstLine.startsWith(META_PREFIX)) {
    const jsonStr = firstLine.slice(META_PREFIX.length);
    meta = JSON.parse(jsonStr) as InspectLogMeta;
    textToParse = csvText.slice(firstNewline + 1);
  }

  const result = Papa.parse<CsvRow>(textToParse, {
    header: true,
    skipEmptyLines: true,
  });

  const events: AgentEvent[] = result.data.map((row) => {
    return {
      sequenceNumber: Number(row.sequenceNumber),
      eventType: row.eventType,
      eventData: JSON.parse(row.eventData),
      createdAt: row.createdAt,
    };
  });

  return { meta, events };
}
