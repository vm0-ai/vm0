import { queryAxiom, getDatasetName, DATASETS } from "../../shared/axiom";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunOutput {
  /** Raw output text from the agent */
  result: string | null;
  /** Run error message (if failed) */
  error: string | null;
}

interface RunOutputQueryOptions {
  /**
   * Wait briefly for Axiom search visibility when a terminal output event has
   * not been indexed yet. User-facing callbacks should wait; best-effort
   * background summaries can opt out.
   */
  waitForOutput?: boolean;
}

// ---------------------------------------------------------------------------
// Axiom query
// ---------------------------------------------------------------------------

interface CodexItem {
  type?: string;
  text?: string;
}

interface RunOutputEvent {
  eventType?: string;
  eventData: {
    result?: string;
    item?: CodexItem;
  };
}

const OUTPUT_EVENT_FILTER = `eventType == "result" or (eventType == "item.completed" and ['eventData.item.type'] == "agent_message")`;
const OUTPUT_QUERY_ATTEMPTS = 4;
const OUTPUT_QUERY_RETRY_MS = 500;

function waitForOutputRetry(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, OUTPUT_QUERY_RETRY_MS);
  });
}

async function queryOutputEventsDesc(runId: string): Promise<RunOutputEvent[]> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where ${OUTPUT_EVENT_FILTER}
| order by sequenceNumber desc
| limit 1`;

  return queryAxiom<RunOutputEvent>(apl);
}

async function queryLatestOutputEvent(
  runId: string,
  options: RunOutputQueryOptions = {},
): Promise<RunOutputEvent | undefined> {
  const attempts = options.waitForOutput === false ? 1 : OUTPUT_QUERY_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const event = (await queryOutputEventsDesc(runId)).find(isOutputEvent);
    if (event || attempt === attempts) {
      return event;
    }
    await waitForOutputRetry();
  }
  return undefined;
}

async function queryAllOutputEvents(runId: string): Promise<RunOutputEvent[]> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where ${OUTPUT_EVENT_FILTER}
| order by sequenceNumber asc`;

  return queryAxiom<RunOutputEvent>(apl);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract structured run output from Axiom.
 *
 * Merges logic previously split across:
 * - `extractResultFromAxiom` (webhook complete handler)
 * - `getRunResultData` / `getRunOutput` (Slack handler)
 *
 * Single Axiom query for terminal output events.
 */
export async function extractRunOutput(
  runId: string,
  error?: string | null,
  options?: RunOutputQueryOptions,
): Promise<RunOutput> {
  const event = await queryLatestOutputEvent(runId, options);

  if (!event) {
    return {
      result: null,
      error: error ?? null,
    };
  }

  return buildRunOutput(event, error);
}

/**
 * Extract ALL structured run outputs from Axiom (ordered by sequence number).
 *
 * A run may produce multiple output events (e.g. intermediate task
 * notifications followed by a final summary). This returns one RunOutput
 * per output event so callers can post each one individually.
 */
export async function extractAllRunOutputs(
  runId: string,
  error?: string | null,
): Promise<RunOutput[]> {
  const events = (await queryAllOutputEvents(runId)).filter(isOutputEvent);

  if (events.length === 0) {
    return [
      {
        result: null,
        error: error ?? null,
      },
    ];
  }

  return events.map((event) => {
    return buildRunOutput(event, error);
  });
}

function extractCodexAgentMessageText(
  item: CodexItem | undefined,
): string | null {
  if (
    item?.type !== "agent_message" ||
    typeof item.text !== "string" ||
    item.text.length === 0
  ) {
    return null;
  }
  return item.text;
}

function isOutputEvent(event: RunOutputEvent): boolean {
  if (event.eventType === "item.completed") {
    return extractCodexAgentMessageText(event.eventData?.item) !== null;
  }

  return event.eventType === "result" || event.eventType === undefined;
}

function extractOutputText(event: RunOutputEvent): string | null {
  const result = event.eventData?.result;
  if (typeof result === "string") return result;

  const item = event.eventData?.item;
  const codexText = extractCodexAgentMessageText(item);
  if (codexText !== null) return codexText;

  return null;
}

function buildRunOutput(
  event: RunOutputEvent,
  error?: string | null,
): RunOutput {
  const result = extractOutputText(event);

  return {
    result,
    error: error ?? null,
  };
}

/**
 * Get ALL formatted run output texts (one per output event).
 *
 * Convenience wrapper for channels that post each output as a separate message.
 */
export async function getAllRunOutputTexts(runId: string): Promise<string[]> {
  const outputs = await extractAllRunOutputs(runId);
  const texts: string[] = [];

  for (const output of outputs) {
    if (output.result) {
      texts.push(output.result);
    }
  }

  return texts;
}

/**
 * Get formatted run output text (result string).
 *
 * Convenience wrapper for channels that just need a string.
 */
export async function getRunOutputText(
  runId: string,
  options?: RunOutputQueryOptions,
): Promise<string | undefined> {
  const output = await extractRunOutput(runId, undefined, options);
  return output.result ?? undefined;
}
