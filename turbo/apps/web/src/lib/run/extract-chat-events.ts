import type { SummaryEntry } from "@vm0/core";
import { queryAxiom, getDatasetName, DATASETS } from "../axiom";

interface AxiomEventContent {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function summarizeContentBlock(
  block: AxiomEventContent,
  skipText: boolean,
): SummaryEntry | null {
  if (block.type === "tool_use" && block.name) {
    return {
      kind: "tool",
      name: block.name,
      ...(block.input ? { input: block.input } : {}),
    };
  }
  if (!skipText && block.type === "text" && block.text) {
    const line = block.text.split("\n")[0] ?? "";
    return {
      kind: "text",
      text: line.length > 80 ? line.slice(0, 80) + "\u2026" : line,
    };
  }
  return null;
}

function findLastTextEventIndex(
  events: Array<{ eventData: { message?: { content?: AxiomEventContent[] } } }>,
): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const content = events[i]?.eventData?.message?.content ?? [];
    if (content.some((b) => b.type === "text" && b.text)) {
      return i;
    }
  }
  return -1;
}

function extractSummariesFromEvents(
  events: Array<{
    eventData: { message?: { content?: AxiomEventContent[] } };
  }>,
): SummaryEntry[] {
  const lastTextIdx = findLastTextEventIndex(events);
  const summaries: SummaryEntry[] = [];

  for (let i = 0; i < events.length; i++) {
    const content = events[i]?.eventData?.message?.content ?? [];
    for (const block of content) {
      const entry = summarizeContentBlock(block, i === lastTextIdx);
      if (entry) {
        summaries.push(entry);
        break;
      }
    }
  }
  return summaries;
}

interface CombinedRunEvent {
  eventType: string;
  eventData: {
    result?: string;
    message?: { content?: AxiomEventContent[] };
  };
}

/**
 * Single Axiom query to fetch both "result" and "assistant" events for a run.
 * Replaces two separate queries (extractRunOutput + extractSummariesFromAxiom)
 * to halve the API call count per completion.
 */
export async function queryRunEventsForChat(runId: string): Promise<{
  resultText: string | null;
  summaries: SummaryEntry[];
}> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where eventType in ("result", "assistant")
| order by sequenceNumber asc
| limit 201`; // 200 assistant events + 1 result event

  const events = await queryAxiom<CombinedRunEvent>(apl);

  // Extract last result event
  const resultEvents = events.filter((e) => e.eventType === "result");
  const lastResult = resultEvents[resultEvents.length - 1];
  const resultText =
    typeof lastResult?.eventData?.result === "string"
      ? lastResult.eventData.result
      : null;

  // Extract summaries from assistant events
  const assistantEvents = events.filter((e) => e.eventType === "assistant");
  const summaries = extractSummariesFromEvents(assistantEvents);

  return { resultText, summaries };
}
